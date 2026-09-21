/* End-to-end smoke test for Super Sinky: real HTTP + real WebSocket frames. */
'use strict';
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

const ROOT = require('path').join(__dirname, '..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const W = 70 * 40;   // world size, mirrors shared/constants.js

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  -> ' + extra : ''));
  if (!cond) failures++;
}

// ---- minimal client-side websocket ----
class WSClient {
  constructor(port, onMsg) {
    this.onMsg = onMsg;
    this.buf = Buffer.alloc(0);
    this.key = crypto.randomBytes(16).toString('base64');
    this.open = false;
    this.sock = net.connect(port, '127.0.0.1', () => {
      this.sock.write(
        'GET / HTTP/1.1\r\nHost: localhost:' + port + '\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: ' + this.key + '\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    this.sock.on('data', (d) => this._data(d));
    this.sock.on('error', (e) => console.log('  socket error', e.code));
  }

  _data(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.open) {
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      const head = this.buf.subarray(0, idx).toString();
      const expect = crypto.createHash('sha1').update(this.key + GUID).digest('base64');
      this.handshakeOk = head.includes('101') && head.includes(expect);
      this.buf = this.buf.subarray(idx + 4);
      this.open = true;
      if (this.onOpen) this.onOpen();
    }
    for (;;) {
      const f = this._frame();
      if (!f) break;
      if (f.opcode === 1) { try { this.onMsg(JSON.parse(f.payload.toString())); } catch (e) {} }
      else if (f.opcode === 9) this._pong(f.payload);   // browsers do this for free
    }
  }

  _frame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const opcode = b[0] & 0x0f;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return null; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (b.length < off + len) return null;
    const payload = b.subarray(off, off + len);
    this.buf = b.subarray(off + len);
    return { opcode, payload };
  }

  _pong(payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    const header = Buffer.from([0x8A, 0x80 | masked.length]);
    try { this.sock.write(Buffer.concat([header, mask, masked])); } catch (e) {}
  }

  send(obj) {
    const data = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(data);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    let header;
    if (data.length < 126) { header = Buffer.from([0x81, 0x80 | data.length]); }
    else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  close() { try { this.sock.destroy(); } catch (e) {} }
}

function get(p) {
  return new Promise((res) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d, type: r.headers['content-type'], cache: r.headers['cache-control'] }));
    }).on('error', (e) => res({ status: 0, body: String(e) }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function run() {
  const srv = spawn('node', ['server/index.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverErr = '';
  srv.stderr.on('data', (d) => { serverErr += d; process.stdout.write('  [server stderr] ' + d); });
  srv.on('exit', (c, sig) => console.log('  [server exited] code=' + c + ' sig=' + sig));
  await sleep(900);

  console.log('\n--- HTTP ---');
  const idx = await get('/');
  check('serves index.html', idx.status === 200 && idx.body.includes('Super&nbsp;Sinky'), 'status ' + idx.status);
  const sh = await get('/shared/constants.js');
  check('serves /shared/constants.js', sh.status === 200 && sh.body.includes('SSConst'));
  const mg = await get('/shared/mapgen.js');
  check('serves /shared/mapgen.js', mg.status === 200 && mg.body.includes('makeMapDef'));
  for (const f of ['js/main.js', 'js/render.js', 'js/terrain.js', 'js/net.js', 'js/ui.js', 'js/input.js', 'js/audio.js', 'css/style.css']) {
    const r = await get('/' + f);
    check('serves ' + f, r.status === 200);
  }
  const trav = await get('/../package.json');
  check('blocks path traversal', trav.status === 404 || trav.status === 403, 'status ' + trav.status);
  console.log('\n--- cache busting ---');
  // A browser must never end up with fresh HTML and stale JavaScript.
  const page = await get('/');
  const tags = (page.body.match(/(?:src|href)="[^"]+"/g) || [])
    .filter((t) => !/^.*"(data:|https?:)/.test(t));
  check('every local asset is versioned',
    tags.length > 5 && tags.every((t) => /\?v=[0-9a-f]+"/.test(t)),
    tags.slice(0, 3).join(' '));
  check('the page itself is never cached',
    /no-store|no-cache/.test(page.cache || ''), page.cache);

  const vm2 = (page.body.match(/\?v=([0-9a-f]+)/) || [])[1];
  const versioned = await get('/js/main.js?v=' + vm2);
  check('a versioned asset is served', versioned.status === 200 && versioned.body.length > 100);
  check('and may be cached hard', /immutable/.test(versioned.cache || ''), versioned.cache);
  const bare = await get('/js/main.js');
  check('an unversioned asset must be revalidated',
    /no-cache/.test(bare.cache || ''), bare.cache);
  check('the build id tracks the files on disk', /^[0-9a-f]{10}$/.test(vm2 || ''), vm2);

  // Touching a served file must change the id, or a stale cache survives.
  {
    const target = require('path').join(ROOT, 'public', 'js', 'ui.js');
    const original = require('fs').readFileSync(target);
    try {
      require('fs').writeFileSync(target, Buffer.concat([original, Buffer.from('\n')]));
      await sleep(2200);
      const again = await get('/');
      const vm3 = (again.body.match(/\?v=([0-9a-f]+)/) || [])[1];
      check('changing a file changes the build id', vm3 && vm3 !== vm2, vm2 + ' -> ' + vm3);
    } finally {
      require('fs').writeFileSync(target, original);
    }
    await sleep(2200);
    const restored = await get('/');
    const vm4 = (restored.body.match(/\?v=([0-9a-f]+)/) || [])[1];
    check('restoring the content restores the id', vm4 === vm2, vm2 + ' -> ' + vm4);
  }

  const hz = await get('/healthz');
  check('healthz responds', hz.status === 200 && JSON.parse(hz.body).ok === true);

  console.log('\n--- WebSocket handshake + lobby ---');
  const inboxA = [];
  const inboxB = [];
  const A = new WSClient(PORT, (m) => inboxA.push(m));
  const B = new WSClient(PORT, (m) => inboxB.push(m));
  await sleep(500);
  check('handshake accepted (client A)', A.handshakeOk === true);
  check('welcome received', inboxA.some((m) => m.t === 'welcome'));
  const idA = (inboxA.find((m) => m.t === 'welcome') || {}).id;
  const idB = (inboxB.find((m) => m.t === 'welcome') || {}).id;
  check('lobby list received', inboxA.some((m) => m.t === 'lobbies'));

  A.send({ t: 'name', name: 'Captain A' });
  B.send({ t: 'name', name: 'Captain B' });
  await sleep(200);
  check('name echoed back', inboxA.some((m) => m.t === 'name' && m.name === 'Captain A'));

  A.send({ t: 'create', name: 'Test Waters', password: 'secret', mode: 'tdm' });
  await sleep(300);
  const lob = inboxA.filter((m) => m.t === 'lobby').pop();
  check('lobby created', !!lob && lob.name === 'Test Waters', lob && lob.name);
  check('creator is host', lob && lob.hostId === idA);
  check('password flagged', lob && lob.hasPassword === true);

  console.log('\n--- password + join ---');
  const listMsg = inboxB.filter((m) => m.t === 'lobbies').pop();
  const lid = lob.id;
  B.send({ t: 'join', id: lid, password: 'wrong' });
  await sleep(200);
  check('wrong password rejected', inboxB.some((m) => m.t === 'joinFailed' && m.reason === 'password'));
  B.send({ t: 'join', id: lid, password: 'secret' });
  await sleep(300);
  const lobB = inboxB.filter((m) => m.t === 'lobby').pop();
  check('correct password joins', !!lobB && lobB.id === lid);
  check('two players in lobby', lobB && lobB.players.length === 2, lobB && lobB.players.length);
  const teams = lobB.players.map((p) => p.team).sort();
  check('TDM auto-balanced across teams', teams[0] === 0 && teams[1] === 1, JSON.stringify(teams));

  console.log('\n--- bots are the host\'s to manage ---');
  inboxB.length = 0;
  B.send({ t: 'addBot', team: 0 });
  await sleep(300);
  check('a guest cannot add bots',
    inboxB.some((m) => m.t === 'error' && /host/i.test(m.msg)),
    JSON.stringify(inboxB.filter((m) => m.t === 'error').map((m) => m.msg)));
  let lb = inboxB.filter((m) => m.t === 'lobby').pop() || lobB;
  check('no bot was added', lb.players.filter((p) => p.bot).length === 0);

  // The host can put bots on either side.
  for (const team of [0, 1, 1]) { A.send({ t: 'addBot', team }); await sleep(140); }
  await sleep(300);
  lb = inboxA.filter((m) => m.t === 'lobby').pop();
  const bots = lb.players.filter((p) => p.bot);
  check('the host can add bots', bots.length === 3, 'bots=' + bots.length);
  const perTeam = [0, 1].map((t) => bots.filter((b) => b.team === t).length);
  check('bots can be put on either side', perTeam[0] === 1 && perTeam[1] === 2,
    perTeam.join(' v '));
  check('the lobby no longer reports a single bot team', lb.botTeam === undefined);
  check('the lobby no longer carries chat', lb.chat === undefined);

  // Removing takes from the side you name.
  A.send({ t: 'removeBot', team: 1 });
  await sleep(300);
  lb = inboxA.filter((m) => m.t === 'lobby').pop();
  const perTeamAfter = [0, 1].map((t) => lb.players.filter((p) => p.bot && p.team === t).length);
  check('a bot is removed from the side named',
    perTeamAfter[0] === 1 && perTeamAfter[1] === 1, perTeamAfter.join(' v '));

  inboxA.length = 0;
  A.send({ t: 'removeBot', team: 1 });
  await sleep(200);
  A.send({ t: 'removeBot', team: 1 });
  await sleep(250);
  check('removing from an empty side is refused',
    inboxA.some((m) => m.t === 'error' && /that side/i.test(m.msg)),
    JSON.stringify(inboxA.filter((m) => m.t === 'error').map((m) => m.msg)));

  inboxB.length = 0;
  B.send({ t: 'removeBot', team: 0 });
  await sleep(250);
  check('a guest cannot remove bots',
    inboxB.some((m) => m.t === 'error' && /host/i.test(m.msg)));

  console.log('\n--- capacity ---');
  inboxA.length = 0;
  for (let i = 0; i < 12; i++) { A.send({ t: 'addBot', team: i % 2 }); await sleep(60); }
  await sleep(400);
  lb = inboxA.filter((m) => m.t === 'lobby').pop();
  check('capacity capped at 8', lb.players.length <= 8, 'players=' + lb.players.length);
  const t0 = lb.players.filter((p) => p.team === 0).length;
  const t1 = lb.players.filter((p) => p.team === 1).length;
  check('teams capped at 4 each', t0 <= 4 && t1 <= 4, t0 + 'v' + t1);
  check('both sides can be filled with bots', t0 === 4 && t1 === 4, t0 + 'v' + t1);
  check('a full side is refused by name',
    inboxA.some((m) => m.t === 'error' && /full/i.test(m.msg)));

  console.log('\n--- non-host cannot start ---');
  B.send({ t: 'start' });
  await sleep(200);
  check('non-host start refused', inboxB.some((m) => m.t === 'error' && /host/i.test(m.msg)));

  console.log('\n--- match ---');
  inboxA.length = 0; inboxB.length = 0;
  A.send({ t: 'start' });
  await sleep(700);
  const start = inboxA.find((m) => m.t === 'start');
  check('start message sent', !!start);
  check('map def included', !!(start && start.map && start.map.def && start.map.def.islands.length > 0),
    start && start.map && start.map.def && ('islands=' + start.map.def.islands.length));
  check('decorations included', !!(start && start.map.decor && start.map.decor.length > 0),
    start && start.map.decor && ('decor=' + start.map.decor.length));
  check('roster included', !!(start && start.roster && start.roster.length === lb.players.length),
    start && start.roster && ('roster=' + start.roster.length));

  await sleep(6000);
  const snaps = inboxA.filter((m) => m.t === 's');
  check('snapshots streaming', snaps.length > 80, 'count=' + snaps.length);
  const snap = snaps[snaps.length - 1];
  check('all ships in snapshot', snap.sh.length === lb.players.length, 'ships=' + snap.sh.length);
  check('wind present', Array.isArray(snap.w) && snap.w[1] >= 0.4 && snap.w[1] <= 1.0, JSON.stringify(snap.w));

  // Bots should be doing something: firing, moving, scoring.
  const allEvents = snaps.flatMap((s) => s.ev || []);
  const kinds = {};
  allEvents.forEach((e) => { kinds[e.k] = (kinds[e.k] || 0) + 1; });
  console.log('  events seen:', JSON.stringify(kinds));

  const moved = snaps[0].sh.some((s0) => {
    const s1 = snap.sh.find((z) => z[0] === s0[0]);
    return s1 && Math.hypot(s1[1] - s0[1], s1[2] - s0[2]) > 30;
  });
  check('ships are under way', moved);

  console.log('\n--- player input reaches the sim ---');
  const myId = start.you;
  check('start.you matches our client id', myId === idA, myId + ' vs ' + idA);
  function mine(s) { return s.sh.find((z) => z[0] === myId); }
  const before = mine(snap);
  check('own ship present before input', !!before, 'myId=' + myId + ' ids=' + snap.sh.map(z=>z[0]).join(','));
  A.send({ t: 'in', d: 1, f: true, s: -1, b: true });
  await sleep(1200);
  const lastSnap = inboxA.filter((m) => m.t === 's').pop();
  const after = lastSnap ? mine(lastSnap) : null;
  check('own ship present after input', !!after, lastSnap ? ('ids=' + lastSnap.sh.map(z=>z[0]).join(',')) : 'no snapshot at all');
  if (!after || !before) { console.log('\n  aborting input checks'); srv.kill('SIGKILL'); process.exit(1); }
  check('firing side applied', after[5] === -1, 'side=' + after[5]);
  check('boost was spent while held', after[15] < 1, 'boost=' + after[15]);
  check('ship tuple carries the full state', after.length === 19, 'len=' + after.length);
  check('boost reserve is reported', after[15] >= 0 && after[15] <= 1, 'boost=' + after[15]);
  const turned = Math.abs(after[3] - before[3]) > 0.15;
  check('steering applied', turned, 'angle ' + before[3].toFixed(2) + ' -> ' + after[3].toFixed(2));

  console.log('\n--- disconnect handling ---');
  B.close();
  await sleep(900);
  const snapAfter = inboxA.filter((m) => m.t === 's').pop();
  check('leaver removed from sim', !snapAfter.sh.some((z) => z[0] === idB), 'ids=' + snapAfter.sh.map((z) => z[0]).join(','));

  console.log('\n--- deathmatch: sustained combat ---');
  A.send({ t: 'leave' });
  await sleep(400);
  inboxA.length = 0;
  A.send({ t: 'create', name: 'Open Sea', password: '', mode: 'dm' });
  await sleep(300);
  for (let i = 0; i < 7; i++) { A.send({ t: 'addBot' }); await sleep(80); }
  await sleep(400);
  const dmLobby = inboxA.filter((m) => m.t === 'lobby').pop();
  check('deathmatch lobby full at 8', dmLobby.players.length === 8, 'players=' + dmLobby.players.length);
  check('no teams in deathmatch', dmLobby.players.every((p) => p.team === -1));

  A.send({ t: 'addBot' });
  await sleep(250);
  check('refuses a 9th ship', inboxA.some((m) => m.t === 'error' && /full/i.test(m.msg)));

  inboxA.length = 0;
  A.send({ t: 'start' });
  // Long enough that an unusually spread-out random map still produces
  // kills; the sink rate averages about four a minute with eight bots.
  await sleep(110000);

  const s2 = inboxA.filter((m) => m.t === 's');
  const ev2 = s2.flatMap((x) => x.ev || []);
  const k2 = {};
  ev2.forEach((e) => { k2[e.k] = (k2[e.k] || 0) + 1; });
  console.log('  events over 110s:', JSON.stringify(k2));
  const last = s2[s2.length - 1];

  // A stalled game loop is silent otherwise, so check sim time really advanced.
  const simTicks = s2[s2.length - 1].k - s2[0].k;
  check('simulation runs for the whole match', simTicks > 95 * 30,
    simTicks + ' ticks over 110s (expect ~3300)');
  check('bots fire their guns', (k2.fire || 0) > 20, 'fire=' + (k2.fire || 0));
  check('shots hit ships', (k2.hit || 0) > 5, 'hit=' + (k2.hit || 0));
  check('shots splash in the sea', (k2.splash || 0) > 5, 'splash=' + (k2.splash || 0));
  check('bots do not waste shots into hillsides', (k2.rock || 0) <= (k2.hit || 0), 'rock=' + (k2.rock || 0));
  check('ships sink', (k2.sink || 0) > 0, 'sink=' + (k2.sink || 0));
  check('sunk ships respawn', (k2.spawn || 0) > 0, 'spawn=' + (k2.spawn || 0));
  check('power-ups spawn', last.pu.length > 0, 'pu=' + last.pu.length);
  check('power-ups carry no expiry field', last.pu.every((q) => q.length === 4), 'tuple len ' + (last.pu[0] || []).length);

  // The round and the closing battle area.
  check('the snapshot carries the time left', typeof last.rt === 'number', last.rt);
  check('the clock is counting down', last.rt < s2[0].rt, s2[0].rt + ' -> ' + last.rt);
  check('the snapshot carries the battle area',
    Array.isArray(last.sz) && last.sz.length === 4, JSON.stringify(last.sz));
  // It closes toward a chosen patch of open water, so it is not symmetric:
  // an edge already against the map border simply stays put.
  check('the area has started closing in',
    (last.sz[2] - last.sz[0]) < W && (last.sz[3] - last.sz[1]) < W,
    JSON.stringify(last.sz) + ' of ' + W);
  check('the area closed in over the run', (last.sz[2] - last.sz[0]) < (s2[0].sz[2] - s2[0].sz[0]),
    (s2[0].sz[2] - s2[0].sz[0]) + ' -> ' + (last.sz[2] - last.sz[0]));
  check('ships stay inside the battle area',
    last.sh.filter((z) => z[9]).every((z) =>
      z[1] >= last.sz[0] - 60 && z[1] <= last.sz[2] + 60 &&
      z[2] >= last.sz[1] - 60 && z[2] <= last.sz[3] + 60),
    'live ships out of bounds');
  check('the closing-in was announced', (k2.shrink || 0) > 0, 'shrink=' + (k2.shrink || 0));
  check('power-ups get collected', (k2.pickup || 0) > 0, 'pickup=' + (k2.pickup || 0));
  check('whirlpools appear', (k2.whirl || 0) > 0, 'whirl=' + (k2.whirl || 0));
  check('wind shifts during play', (k2.wind || 0) > 0, 'wind=' + (k2.wind || 0));

  const scores = last.sh.map((z) => z[12]);
  check('scores are kept', scores.some((v) => v !== 0), JSON.stringify(scores));
  check('roster still complete', last.sh.length === 8, 'ships=' + last.sh.length);
  const hpOk = last.sh.every((z) => z[4] >= 0 && z[4] <= 100);
  check('health stays in range', hpOk, JSON.stringify(last.sh.map((z) => z[4])));
  const inBounds = last.sh.every((z) => z[1] >= 0 && z[1] <= W && z[2] >= 0 && z[2] <= W);
  check('ships stay inside the map', inBounds);

  const bandwidth = s2.reduce((a, x) => a + JSON.stringify(x).length, 0) / 110;
  console.log('  snapshot bandwidth: ' + (bandwidth / 1024).toFixed(1) + ' KiB/s per client at 8 ships');

  console.log('\n--- the round ends on its own ---');
  {
    // Rather than sit through ten minutes, start a lobby and watch that the
    // server is counting toward the end and will finish the match itself.
    const endInbox = [];
    const E = new WSClient(PORT, (m) => endInbox.push(m));
    await sleep(400);
    E.send({ t: 'name', name: 'Timer Tom' });
    E.send({ t: 'create', name: 'Short Round', password: '', mode: 'dm' });
    await sleep(300);
    E.send({ t: 'addBot' });
    await sleep(200);
    endInbox.length = 0;
    E.send({ t: 'start' });
    await sleep(2500);

    const snaps = endInbox.filter((m) => m.t === 's');
    check('a fresh round starts with the full clock',
      snaps.length > 0 && snaps[0].rt > 590, snaps.length ? snaps[0].rt : 'none');
    check('a fresh round starts with the whole map in play',
      snaps[0].sz[0] === 0 && snaps[0].sz[2] === W, JSON.stringify(snaps[0].sz));

    // Ending it by hand must produce the same standings payload the clock
    // running out would.
    endInbox.length = 0;
    E.send({ t: 'endMatch' });
    await sleep(600);
    const over = endInbox.find((m) => m.t === 'matchEnd');
    check('the match ends with a standings table', !!over && Array.isArray(over.standings),
      over ? over.standings.length + ' rows' : 'no matchEnd');
    check('standings carry names, scores, kills and deaths',
      !!over && over.standings.every((r) =>
        typeof r.name === 'string' && typeof r.score === 'number' &&
        typeof r.kills === 'number' && typeof r.deaths === 'number'),
      over ? JSON.stringify(over.standings[0]) : '');
    check('the lobby comes back afterwards',
      endInbox.some((m) => m.t === 'lobby' && m.state === 'lobby'));
    E.send({ t: 'leave' });
    await sleep(300);
    E.close();
  }

  console.log('\n--- an idle client can still act ---');
  // The reported bug: leave the page alone for a while and the Create button
  // stopped doing anything until you refreshed. The server must not quietly
  // drop a connection that is simply quiet, and it must still answer.
  const idleInbox = [];
  const D = new WSClient(PORT, (m) => idleInbox.push(m));
  await sleep(400);
  D.send({ t: 'name', name: 'Idle Ian' });
  await sleep(200);
  check('idle client connected', idleInbox.some((m) => m.t === 'welcome'));

  const idleFor = 62000;          // crosses two 25s server heartbeats
  console.log('  sitting idle for ' + (idleFor / 1000) + 's...');
  await sleep(idleFor);

  idleInbox.length = 0;
  D.send({ t: 'create', name: 'After Idling', password: '', mode: 'dm' });
  await sleep(700);
  const idleLobby = idleInbox.filter((m) => m.t === 'lobby').pop();
  check('creating a lobby works after a long idle', !!idleLobby && idleLobby.name === 'After Idling',
    idleLobby ? idleLobby.name : 'no lobby came back');

  D.send({ t: 'addBot' });
  await sleep(400);
  const idleLobby2 = idleInbox.filter((m) => m.t === 'lobby').pop();
  check('the idle client is still fully interactive',
    idleLobby2 && idleLobby2.players.length === 2, idleLobby2 && idleLobby2.players.length);
  D.close();

  console.log('\n--- host migration ---');
  const C2 = new WSClient(PORT, () => {});
  await sleep(300);
  C2.send({ t: 'name', name: 'Captain C' });
  await sleep(150);

  check('no server crashes', !/Error|Cannot|undefined is not/.test(serverErr), serverErr.slice(0, 500));

  A.close(); C2.close();
  srv.kill('SIGTERM');
  await sleep(500);
  srv.kill('SIGKILL');

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();
