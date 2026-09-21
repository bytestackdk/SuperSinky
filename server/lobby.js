/* Super Sinky - lobby lifecycle and the per-lobby game loop. */
'use strict';

const C = require('../shared/constants.js');
const { Game } = require('./game.js');
const { BotBrain, botName } = require('./bot.js');

const TICK_MS = Math.round(1000 / C.TICK_HZ);
const SNAPSHOT_EVERY = Math.round(C.TICK_HZ / C.SNAPSHOT_HZ);
const CTRL = /[\x00-\x1f\x7f]/g;

let lobbySeq = 1;
let entitySeq = 1000000;   // ship ids for bots live above client ids

function sanitizeName(raw, fallback) {
  let n = String(raw == null ? '' : raw).replace(CTRL, '').trim();
  n = n.slice(0, C.PLAYER_NAME_MAX);
  return n.length ? n : fallback;
}

class Lobby {
  constructor(manager, name, password, mode, host) {
    this.manager = manager;
    this.id = 'L' + (lobbySeq++);
    this.name = name;
    this.password = password || '';
    this.mode = mode === C.MODE_TDM ? C.MODE_TDM : C.MODE_DM;
    this.hostId = host ? host.id : null;
    this.members = new Map();          // clientId -> client
    this.bots = new Map();             // shipId -> { id, name, team, colorIdx, brain }
    this.state = 'lobby';              // 'lobby' | 'playing'
    this.game = null;
    this.timer = null;
    this.lastTime = 0;
    this.accumulator = 0;
    this.tickCount = 0;
    this.createdAt = Date.now();
  }

  // ---- membership ----------------------------------------------------

  get playerCount() { return this.members.size + this.bots.size; }
  get capacity() { return C.MAX_PLAYERS; }
  get isFull() { return this.playerCount >= this.capacity; }

  teamCount(team) {
    let n = 0;
    for (const c of this.members.values()) if (c.team === team) n++;
    for (const b of this.bots.values()) if (b.team === team) n++;
    return n;
  }

  /** Server-side automatic team balancing. */
  assignTeam() {
    if (this.mode !== C.MODE_TDM) return -1;
    const a = this.teamCount(0), b = this.teamCount(1);
    if (a <= b && a < C.TEAM_SIZE) return 0;
    if (b < C.TEAM_SIZE) return 1;
    return a <= b ? 0 : 1;
  }

  usedColorIdx() {
    const used = new Set();
    for (const c of this.members.values()) used.add(c.colorIdx);
    for (const b of this.bots.values()) used.add(b.colorIdx);
    return used;
  }

  nextColorIdx() {
    const used = this.usedColorIdx();
    for (let i = 0; i < C.FFA_COLORS.length; i++) if (!used.has(i)) return i;
    return 0;
  }

  takenNames() {
    const s = new Set();
    for (const c of this.members.values()) s.add(c.name);
    for (const b of this.bots.values()) s.add(b.name);
    return s;
  }

  add(client) {
    if (this.isFull) return { ok: false, error: 'Lobby is full' };
    if (this.mode === C.MODE_TDM) {
      const t = this.assignTeam();
      if (this.teamCount(t) >= C.TEAM_SIZE) return { ok: false, error: 'Both teams are full' };
      client.team = t;
    } else {
      client.team = -1;
    }
    client.colorIdx = this.nextColorIdx();
    client.lobby = this;
    this.members.set(client.id, client);
    if (!this.hostId || !this.members.has(this.hostId)) this.hostId = client.id;

    if (this.state === 'playing' && this.game) {
      this.game.addShip(client.id, client.name, client.team, client.colorIdx, false);
      this.sendStart(client);
      this.broadcastRoster();
    }
    return { ok: true };
  }

  remove(client) {
    if (!this.members.has(client.id)) return;
    this.members.delete(client.id);
    client.lobby = null;
    client.team = -1;
    if (this.game) this.game.removeShip(client.id);

    if (this.hostId === client.id) {
      const next = this.members.keys().next();
      this.hostId = next.done ? null : next.value;
    }
    if (this.members.size === 0) {
      this.manager.destroy(this);
    } else {
      this.broadcastRoster();
      this.broadcastLobby();
    }
  }

  // ---- bots ----------------------------------------------------------

  /** `team` is honoured in team deathmatch; in a free-for-all it is ignored. */
  addBot(team) {
    if (this.isFull) return { ok: false, error: 'Lobby is full' };

    if (this.mode === C.MODE_TDM) {
      // The host picks a side for each bot, so both fleets can be filled.
      team = (team === 0 || team === 1) ? team : this.assignTeam();
      if (this.teamCount(team) >= C.TEAM_SIZE) {
        return { ok: false, error: C.TEAM_NAMES[team] + ' is full' };
      }
    } else {
      team = -1;
    }

    const id = entitySeq++;
    const bot = {
      id,
      name: botName(this.takenNames()),
      team,
      colorIdx: this.nextColorIdx(),
      brain: null
    };
    this.bots.set(id, bot);

    if (this.state === 'playing' && this.game) {
      const ship = this.game.addShip(id, bot.name, team, bot.colorIdx, true);
      bot.brain = new BotBrain(ship);
      ship.bot = bot.brain;
      this.broadcastRoster();
    }
    this.broadcastLobby();
    return { ok: true };
  }

  removeBot(team) {
    const wanted = (this.mode === C.MODE_TDM && (team === 0 || team === 1)) ? team : null;
    const ids = [...this.bots.keys()].filter(
      (id) => wanted === null || this.bots.get(id).team === wanted);

    if (!ids.length) {
      return {
        ok: false,
        error: wanted === null ? 'No bots to remove' : 'No bots on that side'
      };
    }

    const lastId = ids[ids.length - 1];
    this.bots.delete(lastId);
    if (this.game) this.game.removeShip(lastId);
    if (this.state === 'playing') this.broadcastRoster();
    this.broadcastLobby();
    return { ok: true };
  }

  // ---- match lifecycle -----------------------------------------------

  start() {
    if (this.state === 'playing') return { ok: false, error: 'Already under way' };
    if (this.members.size === 0) return { ok: false, error: 'Nobody in the lobby' };

    this.game = new Game(this.mode);
    this.state = 'playing';

    for (const c of this.members.values()) {
      this.game.addShip(c.id, c.name, c.team, c.colorIdx, false);
    }
    for (const b of this.bots.values()) {
      const ship = this.game.addShip(b.id, b.name, b.team, b.colorIdx, true);
      b.brain = new BotBrain(ship);
      ship.bot = b.brain;
    }

    for (const c of this.members.values()) this.sendStart(c);
    this.broadcastRoster();

    this.lastTime = Date.now();
    this.accumulator = 0;
    this.tickCount = 0;
    this.timer = setInterval(() => this.loop(), TICK_MS);
    this.manager.broadcastLobbyList();
    return { ok: true };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.state = 'lobby';
    this.game = null;
    for (const b of this.bots.values()) b.brain = null;
  }

  /** Return everybody to the lobby screen without destroying the lobby. */
  endMatch() {
    if (this.state !== 'playing') return;
    const standings = this.game ? this.game.standings() : [];
    const ranOut = this.game ? this.game.isOver : false;
    this.stop();
    this.broadcast({ t: 'matchEnd', standings, mode: this.mode, timeUp: ranOut });
    this.broadcastLobby();
    this.manager.broadcastLobbyList();
  }

  loop() {
    const now = Date.now();
    let elapsed = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (elapsed > 0.25) elapsed = 0.25;          // don't spiral after a stall
    this.accumulator += elapsed;

    const step = 1 / C.TICK_HZ;
    let guard = 0;
    while (this.accumulator >= step && guard++ < 8) {
      this.accumulator -= step;
      for (const b of this.bots.values()) if (b.brain) b.brain.update(this.game, step);
      this.game.update(step);
      this.tickCount++;
      if (this.tickCount % SNAPSHOT_EVERY === 0) this.broadcastSnapshot();

      if (this.game.isOver) { this.endMatch(); return; }
    }
  }

  // ---- outbound ------------------------------------------------------

  sendStart(client) {
    client.send({
      t: 'start',
      you: client.id,
      mode: this.mode,
      map: this.game.mapPayload(),
      roster: this.game.roster(),
      const: { tile: C.TILE, world: C.WORLD }
    });
  }

  broadcastSnapshot() {
    const payload = JSON.stringify(this.game.snapshot());
    for (const c of this.members.values()) c.sendRaw(payload);
  }

  broadcastRoster() {
    if (!this.game) return;
    this.broadcast({ t: 'roster', roster: this.game.roster() });
  }

  broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const c of this.members.values()) c.sendRaw(payload);
  }

  lobbyState() {
    const players = [];
    for (const c of this.members.values()) {
      players.push({ id: c.id, name: c.name, team: c.team, colorIdx: c.colorIdx, bot: false, host: c.id === this.hostId });
    }
    for (const b of this.bots.values()) {
      players.push({ id: b.id, name: b.name, team: b.team, colorIdx: b.colorIdx, bot: true, host: false });
    }
    return {
      t: 'lobby',
      id: this.id,
      name: this.name,
      mode: this.mode,
      hostId: this.hostId,
      state: this.state,
      hasPassword: !!this.password,
      capacity: this.capacity,
      teamSize: C.TEAM_SIZE,
      players
    };
  }

  broadcastLobby() {
    this.broadcast(this.lobbyState());
    this.manager.broadcastLobbyList();
  }

  summary() {
    return {
      id: this.id,
      name: this.name,
      mode: this.mode,
      players: this.members.size,
      bots: this.bots.size,
      capacity: this.capacity,
      hasPassword: !!this.password,
      state: this.state
    };
  }
}

class LobbyManager {
  constructor() {
    this.lobbies = new Map();
    this.clients = new Set();
    this._listDirty = false;
    setInterval(() => this._flushList(), 300).unref();
  }

  create(name, password, mode, host) {
    const clean = String(name || '').replace(CTRL, '').trim().slice(0, C.LOBBY_NAME_MAX);
    if (!clean) return { ok: false, error: 'Give the lobby a name' };
    if (this.lobbies.size >= 200) return { ok: false, error: 'Server is at capacity' };
    const lobby = new Lobby(this, clean, password, mode, host);
    this.lobbies.set(lobby.id, lobby);
    return { ok: true, lobby };
  }

  destroy(lobby) {
    lobby.stop();
    this.lobbies.delete(lobby.id);
    this.broadcastLobbyList();
  }

  list() {
    const out = [];
    for (const l of this.lobbies.values()) out.push(l.summary());
    out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return out;
  }

  broadcastLobbyList() { this._listDirty = true; }

  _flushList() {
    if (!this._listDirty) return;
    this._listDirty = false;
    const payload = JSON.stringify({ t: 'lobbies', list: this.list() });
    for (const c of this.clients) if (!c.lobby) c.sendRaw(payload);
  }
}

module.exports = { Lobby, LobbyManager, sanitizeName };
