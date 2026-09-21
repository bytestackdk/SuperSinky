/* Super Sinky - HTTP static host + WebSocket game server.
 *
 * Run with: node server/index.js   (PORT env var honoured, default 3000)
 * No npm dependencies: everything it needs ships with Node.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { attach } = require('./ws.js');
const { LobbyManager, sanitizeName } = require('./lobby.js');
const C = require('../shared/constants.js');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SHARED = path.join(ROOT, 'shared');

// ---------------------------------------------------------------------------
// Cache busting
//
// index.html is served no-cache, but the scripts and stylesheet it pulls in
// were not versioned - so after a server update a browser would take fresh
// HTML and keep serving stale JavaScript from its cache, leaving the page a
// mix of old and new code. Every local asset reference in the HTML now
// carries a build id derived from the files on disk, so a changed file gets
// a new URL and is fetched immediately, while unchanged ones stay cached.
// ---------------------------------------------------------------------------

const ASSET_DIRS = ['public/js', 'public/css', 'shared'];
let buildId = '0';
let cachedHtml = null;
let cachedHtmlFor = null;

let buildMemo = { at: 0, id: null };

/**
 * Hashed from the asset contents rather than their timestamps, so the id only
 * moves when something a browser would actually need to refetch has changed.
 * Memoised briefly - a page load reads a couple of hundred kilobytes.
 */
function computeBuildId() {
  const now = Date.now();
  if (buildMemo.id && now - buildMemo.at < 2000) return buildMemo.id;

  const h = require('crypto').createHash('sha1');
  for (const rel of ASSET_DIRS) {
    const dir = path.join(ROOT, rel);
    let names;
    try { names = fs.readdirSync(dir).sort(); } catch (_) { continue; }
    for (const n of names) {
      try {
        const full = path.join(dir, n);
        if (!fs.statSync(full).isFile()) continue;
        h.update(rel + '/' + n);
        h.update(fs.readFileSync(full));
      } catch (_) { /* vanished mid-scan */ }
    }
  }
  buildMemo = { at: now, id: h.digest('hex').slice(0, 10) };
  return buildMemo.id;
}

/** Append ?v=<build> to every local script/link the page pulls in. */
function versionHtml(html, build) {
  return html.replace(/\s(src|href)="([^"]+)"/g, (whole, attr, url) => {
    if (/^(data:|https?:|\/\/|#|mailto:)/i.test(url) || url.indexOf('?') >= 0) return whole;
    return ' ' + attr + '="' + url + '?v=' + build + '"';
  });
}

function indexHtml() {
  const build = computeBuildId();
  if (cachedHtml && cachedHtmlFor === build) return { body: cachedHtml, build };
  const raw = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  cachedHtml = versionHtml(raw, build);
  cachedHtmlFor = build;
  buildId = build;
  return { body: cachedHtml, build };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function resolveStatic(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';

  let base = PUBLIC;
  if (p.startsWith('/shared/')) {
    base = SHARED;
    p = p.slice('/shared'.length);
  }

  const full = path.normalize(path.join(base, p));
  // Refuse anything that escapes the served roots.
  if (!full.startsWith(PUBLIC) && !full.startsWith(SHARED)) return null;
  return full;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end('Method Not Allowed');
    return;
  }

  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      lobbies: manager.lobbies.size,
      clients: manager.clients.size,
      uptime: Math.round(process.uptime())
    }));
    return;
  }

  const file = resolveStatic(req.url);
  if (!file) { res.writeHead(403).end('Forbidden'); return; }

  // The page itself is rewritten with the current build id and never cached.
  if (path.extname(file).toLowerCase() === '.html') {
    let page;
    try { page = indexHtml(); } catch (_) { res.writeHead(404).end('Not Found'); return; }
    const body = Buffer.from(page.body, 'utf8');
    res.writeHead(200, {
      'Content-Type': MIME['.html'],
      'Content-Length': body.length,
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404).end('Not Found'); return; }
    const ext = path.extname(file).toLowerCase();
    // A versioned URL changes whenever the file does, so it is safe to keep
    // for a long time. An unversioned one must be revalidated every time.
    const versioned = /[?&]v=/.test(req.url);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': versioned
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, must-revalidate'
    });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
});

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const manager = new LobbyManager();
let clientSeq = 1;

class Client {
  constructor(conn) {
    this.id = clientSeq++;
    this.conn = conn;
    this.name = 'Sailor';
    this.lobby = null;
    this.team = -1;
    this.colorIdx = 0;
    this.lastInputAt = 0;
    this.msgBudget = 0;
    this.budgetResetAt = 0;
  }

  send(obj) { this.sendRaw(JSON.stringify(obj)); }
  sendRaw(str) { try { this.conn.send(str); } catch (_) { /* dropped */ } }
  error(msg) { this.send({ t: 'error', msg }); }
}

attach(server, (conn) => {
  const client = new Client(conn);
  manager.clients.add(client);

  client.send({ t: 'welcome', id: client.id, protocol: C.PROTOCOL });
  client.send({ t: 'lobbies', list: manager.list() });

  conn.on('message', (raw) => {
    // Cheap flood protection: 120 messages per second per client.
    const now = Date.now();
    if (now > client.budgetResetAt) { client.budgetResetAt = now + 1000; client.msgBudget = 0; }
    if (++client.msgBudget > 120) return;

    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    handle(client, msg);
  });

  conn.on('close', () => {
    if (client.lobby) client.lobby.remove(client);
    manager.clients.delete(client);
  });
});

function handle(client, msg) {
  const lobby = client.lobby;

  switch (msg.t) {
    // ---- identity ----------------------------------------------------
    case 'name': {
      client.name = sanitizeName(msg.name, 'Sailor ' + client.id);
      client.send({ t: 'name', name: client.name });
      if (lobby) {
        if (lobby.game) {
          const ship = lobby.game.ships.get(client.id);
          if (ship) ship.name = client.name;
          lobby.broadcastRoster();
        }
        lobby.broadcastLobby();
      }
      break;
    }

    // ---- lobby browser ------------------------------------------------
    case 'lobbies':
      client.send({ t: 'lobbies', list: manager.list() });
      break;

    case 'create': {
      if (lobby) { client.error('Leave your current lobby first'); break; }
      const res = manager.create(msg.name, msg.password, msg.mode, client);
      if (!res.ok) { client.error(res.error); break; }
      const joined = res.lobby.add(client);
      if (!joined.ok) { manager.destroy(res.lobby); client.error(joined.error); break; }
      client.send(res.lobby.lobbyState());
      res.lobby.broadcastLobby();
      break;
    }

    case 'join': {
      if (lobby) { client.error('Leave your current lobby first'); break; }
      const target = manager.lobbies.get(msg.id);
      if (!target) { client.error('That lobby no longer exists'); break; }
      if (target.password && String(msg.password || '') !== target.password) {
        client.send({ t: 'joinFailed', id: msg.id, reason: 'password' });
        break;
      }
      const res = target.add(client);
      if (!res.ok) { client.error(res.error); break; }
      client.send(target.lobbyState());
      target.broadcastLobby();
      break;
    }

    case 'leave': {
      if (!lobby) break;
      lobby.remove(client);
      client.send({ t: 'left' });
      client.send({ t: 'lobbies', list: manager.list() });
      break;
    }

    // ---- lobby actions -------------------------------------------------
    // Bots are the lobby owner's to manage.
    case 'addBot': {
      if (!lobby) break;
      if (lobby.hostId !== client.id) { client.error('Only the host can add bots'); break; }
      const res = lobby.addBot(msg.team);
      if (!res.ok) client.error(res.error);
      break;
    }

    case 'removeBot': {
      if (!lobby) break;
      if (lobby.hostId !== client.id) { client.error('Only the host can remove bots'); break; }
      const res = lobby.removeBot(msg.team);
      if (!res.ok) client.error(res.error);
      break;
    }

    case 'start': {
      if (!lobby) break;
      if (lobby.hostId !== client.id) { client.error('Only the host can weigh anchor'); break; }
      const res = lobby.start();
      if (!res.ok) client.error(res.error);
      break;
    }

    case 'endMatch': {
      if (!lobby) break;
      if (lobby.hostId !== client.id) { client.error('Only the host can end the match'); break; }
      lobby.endMatch();
      break;
    }

    // ---- gameplay ------------------------------------------------------
    case 'in': {
      if (!lobby || !lobby.game) break;
      lobby.game.applyInput(client.id, msg);
      break;
    }

    case 'ping':
      client.send({ t: 'pong', c: msg.c });
      break;
  }
}

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ~~~  S U P E R   S I N K Y  ~~~');
  console.log('  Serving on http://localhost:' + PORT);
  console.log('  Map ' + C.WORLD + 'x' + C.WORLD + '  |  tick ' + C.TICK_HZ + 'Hz  |  snapshots ' + C.SNAPSHOT_HZ + 'Hz');
  console.log('  Build ' + computeBuildId());
  console.log('');
});

function shutdown() {
  console.log('\nStriking the colours...');
  for (const l of manager.lobbies.values()) l.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
