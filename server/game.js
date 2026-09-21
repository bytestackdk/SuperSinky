/* Super Sinky - authoritative game simulation.
 *
 * The server owns all state. Clients only send intent (turn / side / range /
 * fire) and receive snapshots; nothing gameplay-relevant is decided in the
 * browser.
 */
'use strict';

const C = require('../shared/constants.js');
const M = require('../shared/mapgen.js');

const TAU = Math.PI * 2;
const T = C.TERRAIN;

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }

/** Shortest signed difference between two angles. */
function angDiff(a, b) {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

let nextEntityId = 1;
function eid() { return nextEntityId++; }

// ---------------------------------------------------------------------------
// Ship
// ---------------------------------------------------------------------------

class Ship {
  constructor(id, name, team, colorIdx, isBot) {
    this.id = id;
    this.name = name;
    this.team = team;              // 0 / 1 in TDM, -1 in deathmatch
    this.colorIdx = colorIdx;
    this.isBot = !!isBot;

    this.x = 0; this.y = 0;
    this.angle = 0;
    this.speed = 0;
    this.hp = C.SHIP_HP;
    this.alive = true;
    this.respawnAt = 0;

    this.side = 1;                 // -1 port, +1 starboard
    this.cannons = C.CANNONS_BASE;
    this.sailStacks = 0;
    this.rapidStacks = 0;
    this.superUntil = 0;
    this.reloadAt = 0;
    this.protectUntil = 0;

    this.boost = 1;                // reserve, 0..1
    this.boosting = false;
    this.combatAt = 0;             // last time she fired or was hurt

    this.score = 0;
    this.kills = 0;
    this.deaths = 0;

    this.powerups = [];            // tokens held, used to decide sink drops
    this.input = { turn: 0, fire: false, boost: false };

    this.stunUntil = 0;
    // Far in the past, so the very first collision of a match still counts.
    this.groundHitAt = -1e9;
    this.collideAt = -1e9;
    this.bot = null;               // bot brain, when isBot
  }

  get sailMult() { return 1 + this.sailStacks * C.SAIL_BONUS; }
  get reloadTime() { return C.RELOAD * Math.pow(1 - C.RAPID_BONUS, this.rapidStacks); }
  isSuper(now) { return now < this.superUntil; }
  isRegenerating(now) {
    return this.alive && this.hp < C.SHIP_HP && now - this.combatAt >= C.REGEN_DELAY;
  }

  resetForSpawn(x, y, angle, now) {
    this.x = x; this.y = y; this.angle = angle;
    this.speed = 0;
    this.hp = C.SHIP_HP;
    this.alive = true;
    this.cannons = C.CANNONS_BASE;
    this.sailStacks = 0;
    this.rapidStacks = 0;
    this.superUntil = 0;
    this.boost = 1;
    this.boosting = false;
    this.combatAt = now;
    this.reloadAt = now + 1.0;
    this.protectUntil = now + C.SPAWN_PROTECT;
    this.powerups = [];
    this.stunUntil = 0;
    this.groundHitAt = -1e9;
    this.collideAt = -1e9;
    this.input.turn = 0;
    this.input.fire = false;
    this.input.boost = false;
  }

  /** Is a world point inside this ship's hull? (oriented ellipse) */
  contains(px, py, pad) {
    const dx = px - this.x, dy = py - this.y;
    const c = Math.cos(-this.angle), s = Math.sin(-this.angle);
    const lx = dx * c - dy * s;
    const ly = dx * s + dy * c;
    const a = C.SHIP_HALF_LEN + (pad || 0);
    const b = C.SHIP_HALF_BEAM * 1.35 + (pad || 0);
    return (lx * lx) / (a * a) + (ly * ly) / (b * b) <= 1;
  }
}

// ---------------------------------------------------------------------------
// Game
// ---------------------------------------------------------------------------

class Game {
  constructor(mode, seed) {
    this.mode = mode;                       // C.MODE_DM | C.MODE_TDM
    this.def = M.makeMapDef(seed || ((Math.random() * 0xfffffff) | 0) + 1);
    this.tiles = null;
    this.spawns = [];
    this.decor = [];
    this._buildTerrain();

    this.time = 0;
    this.tick = 0;
    this.ships = new Map();                 // id -> Ship
    this.projectiles = [];
    this.powerups = [];
    this.whirlpools = [];
    this.events = [];

    this.windDir = Math.random() * TAU;
    this.windStrength = rand(0.7, 0.95);
    this.windTargetDir = this.windDir;
    this.windTargetStrength = this.windStrength;
    this.windChangeAt = rand(C.WIND_CHANGE_EVERY[0], C.WIND_CHANGE_EVERY[1]);

    this.nextPowerupAt = rand(1, 3);
    this.nextWhirlAt = rand(C.WHIRL_SPAWN[0], C.WHIRL_SPAWN[1]);

    // The battle area closes in a step at a time over the round, toward a
    // patch of open water rather than the middle of the map.
    this.zoneFinal = this._chooseFinalArena();
    this.zoneProgress = 0;
    this.zoneShrinks = 0;
  }

  /**
   * Where the round should end up. Closing on the geometric centre regularly
   * produced a final arena that was half island, which makes for a miserable
   * endgame - so sample the map and pick somewhere with plenty of sea room.
   */
  _chooseFinalArena() {
    const half = C.WORLD * C.ZONE_FINAL / 2;
    const lo = half, hi = C.WORLD - half;
    const cands = [];

    for (let cy = lo; cy <= hi; cy += 80) {
      for (let cx = lo; cx <= hi; cx += 80) {
        let land = 0, cells = 0;
        for (let y = cy - half; y <= cy + half; y += 40) {
          for (let x = cx - half; x <= cx + half; x += 40) {
            cells++;
            if (this.isLand(x, y)) land++;
          }
        }
        cands.push({ x: cx, y: cy, land: land / cells });
      }
    }

    cands.sort((a, b) => a.land - b.land);
    // Pick among the clearest handful so every round closes somewhere new.
    const take = Math.max(1, Math.floor(cands.length * 0.08));
    const chosen = cands[(Math.random() * take) | 0];
    return [chosen.x - half, chosen.y - half, chosen.x + half, chosen.y + half];
  }

  /** The water still being fought over, as [x0, y0, x1, y1]. */
  get zone() {
    const p = this.zoneProgress;
    const f = this.zoneFinal;
    return [
      f[0] * p,
      f[1] * p,
      C.WORLD + (f[2] - C.WORLD) * p,
      C.WORLD + (f[3] - C.WORLD) * p
    ];
  }

  get timeLeft() { return Math.max(0, C.ROUND_SECONDS - this.time); }
  get isOver() { return this.time >= C.ROUND_SECONDS; }

  inZone(x, y, inset) {
    const z = this.zone;
    const i = inset || 0;
    return x >= z[0] + i && y >= z[1] + i && x <= z[2] - i && y <= z[3] - i;
  }

  // ---- terrain -------------------------------------------------------

  _buildTerrain() {
    const N = C.MAP_TILES;
    const tiles = new Uint8Array(N * N);
    for (let ty = 0; ty < N; ty++) {
      for (let tx = 0; tx < N; tx++) {
        const h = M.heightAt(this.def, tx * C.TILE + C.TILE / 2, ty * C.TILE + C.TILE / 2);
        tiles[ty * N + tx] = M.terrainFromHeight(h);
      }
    }
    this.tiles = tiles;
    this._buildSpawns();
    this._buildDecor();
  }

  _buildSpawns() {
    const N = C.MAP_TILES;
    const margin = 3;
    const out = [];
    for (let ty = margin; ty < N - margin; ty += 2) {
      for (let tx = margin; tx < N - margin; tx += 2) {
        let clear = true;
        for (let dy = -2; dy <= 2 && clear; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (this.tiles[(ty + dy) * N + (tx + dx)] >= T.SAND) { clear = false; break; }
          }
        }
        if (clear) out.push({ x: tx * C.TILE + C.TILE / 2, y: ty * C.TILE + C.TILE / 2 });
      }
    }
    this.spawns = out;
  }

  /** Decorative buildings / trees / rocks, generated once and sent to clients. */
  _buildDecor() {
    const N = C.MAP_TILES;
    const rnd = M.mulberry32(this.def.seed ^ 0x5f3a91);
    const decor = [];
    let lighthouses = 0;

    for (let ty = 1; ty < N - 1; ty++) {
      for (let tx = 1; tx < N - 1; tx++) {
        const t = this.tiles[ty * N + tx];
        if (t < T.SAND) continue;
        const cx = tx * C.TILE + C.TILE / 2;
        const cy = ty * C.TILE + C.TILE / 2;
        const coastal = this._neighbourHasWater(tx, ty);
        const r = rnd();
        let kind = null;

        if (t === T.GRASS) {
          if (r < 0.34) kind = 'tree';
          else if (r < 0.40) kind = 'house';
          else if (r < 0.418) kind = 'windmill';
          else if (r < 0.432 && coastal) kind = 'dock';
        } else if (t === T.HILL) {
          if (r < 0.30) kind = 'pine';
          else if (r < 0.325) kind = 'tower';
        } else if (t === T.MOUNTAIN) {
          if (r < 0.22) kind = 'rock';
        } else if (t === T.SAND && coastal) {
          if (r < 0.035 && lighthouses < 7) { kind = 'lighthouse'; lighthouses++; }
          else if (r < 0.20) kind = 'palm';
          else if (r < 0.26) kind = 'rock';
        }

        if (kind) {
          decor.push({
            k: kind,
            x: Math.round(cx + (rnd() - 0.5) * C.TILE * 0.7),
            y: Math.round(cy + (rnd() - 0.5) * C.TILE * 0.7),
            r: Math.round(rnd() * 628) / 100,
            s: Math.round((0.8 + rnd() * 0.5) * 100) / 100
          });
        }
      }
    }
    this.decor = decor;
  }

  _neighbourHasWater(tx, ty) {
    const N = C.MAP_TILES;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = this.tiles[(ty + dy) * N + (tx + dx)];
        if (t < T.SAND) return true;
      }
    }
    return false;
  }

  terrainAt(x, y) {
    const N = C.MAP_TILES;
    const tx = (x / C.TILE) | 0;
    const ty = (y / C.TILE) | 0;
    if (tx < 0 || ty < 0 || tx >= N || ty >= N) return T.WATER;
    return this.tiles[ty * N + tx];
  }

  isLand(x, y) { return this.terrainAt(x, y) >= T.SAND; }
  blocksShot(x, y) { return this.terrainAt(x, y) >= T.HILL; }

  /** True if a cannon ball could travel from a to b unobstructed. */
  hasLineOfFire(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    const steps = Math.ceil(dist / (C.TILE * 0.5));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      if (this.blocksShot(x0 + dx * t, y0 + dy * t)) return false;
    }
    return true;
  }

  // ---- roster --------------------------------------------------------

  addShip(id, name, team, colorIdx, isBot) {
    const s = new Ship(id, name, team, colorIdx, isBot);
    this.ships.set(id, s);
    const sp = this.chooseSpawn(team);
    s.resetForSpawn(sp.x, sp.y, sp.angle, this.time);
    return s;
  }

  removeShip(id) { this.ships.delete(id); }

  /** Pick a quiet stretch of open water; in TDM, lean toward friends. */
  chooseSpawn(team) {
    if (!this.spawns.length) {
      return { x: C.WORLD / 2, y: C.WORLD / 2, angle: Math.random() * TAU };
    }

    // Only water still inside the battle area is worth spawning on.
    const inside = this.spawns.filter((c) => this.inZone(c.x, c.y, C.SHIP_LEN));
    const pool = inside.length ? inside : this.spawns;

    let best = null, bestScore = -Infinity;
    const samples = Math.min(60, pool.length);

    for (let i = 0; i < samples; i++) {
      const cand = pick(pool);
      let nearestEnemy = Infinity, nearestFriend = Infinity, nearestAny = Infinity;

      for (const s of this.ships.values()) {
        if (!s.alive) continue;
        const d = Math.hypot(s.x - cand.x, s.y - cand.y);
        nearestAny = Math.min(nearestAny, d);
        if (this.mode === C.MODE_TDM && s.team === team) nearestFriend = Math.min(nearestFriend, d);
        else nearestEnemy = Math.min(nearestEnemy, d);
      }

      // Distances are expressed relative to the map so the placement rules
      // keep working if the world size changes.
      const FAR = C.WORLD * 0.48;
      const NEAR = C.WORLD * 0.135;

      // Base desire: keep clear of everyone, and especially of enemies.
      let score = Math.min(nearestAny, FAR) * 0.6 + Math.min(nearestEnemy, FAR * 1.3) * 0.9;
      if (nearestAny < NEAR) score -= 2500;          // too close to any fight

      // Team deathmatch: spawn nearer to your own fleet than to the enemy.
      if (this.mode === C.MODE_TDM && nearestFriend < Infinity) {
        score += Math.max(0, FAR * 0.94 - nearestFriend) * 1.1;
        if (nearestFriend < NEAR) score -= 900;      // but not on top of them
      }

      for (const w of this.whirlpools) {
        const d = Math.hypot(w.x - cand.x, w.y - cand.y);
        if (d < C.WHIRL_RADIUS + 200) score -= 4000;
      }
      for (const p of this.projectiles) {
        if (Math.hypot(p.x - cand.x, p.y - cand.y) < NEAR * 1.2) score -= 700;
      }

      score += Math.random() * 120;                  // avoid always picking the same tile
      if (score > bestScore) { bestScore = score; best = cand; }
    }

    return { x: best.x, y: best.y, angle: Math.random() * TAU };
  }

  // ---- input ---------------------------------------------------------

  applyInput(id, msg) {
    const s = this.ships.get(id);
    if (!s) return;
    s.input.turn = clamp(Math.round(msg.d || 0), -1, 1);
    s.input.fire = !!msg.f;
    s.input.boost = !!msg.b;
    if (msg.s === -1 || msg.s === 1) s.side = msg.s;
  }

  /** Anything that counts as being in action, which holds off repairs. */
  markCombat(ship) { if (ship) ship.combatAt = this.time; }

  // ---- main loop -----------------------------------------------------

  update(dt) {
    this.time += dt;
    this.tick++;

    this._updateWind(dt);
    this._updateZone(dt);
    this._updateShips(dt);
    this._updateProjectiles(dt);
    this._updateWhirlpools(dt);
    this._updatePowerups(dt);
    this._updateCollisions(dt);
    this._updateRespawns();
  }

  /**
   * Once a minute the battle area closes in another step. The boundary eases
   * inward over a few seconds rather than jumping, so you can see it coming
   * and still sail clear of it.
   */
  _updateZone(dt) {
    let want = 0;
    if (this.time >= C.SHRINK_START) {
      want = Math.min(C.SHRINK_STEPS,
        Math.floor((this.time - C.SHRINK_START) / C.SHRINK_EVERY) + 1);
    }
    if (want > this.zoneShrinks) {
      this.zoneShrinks = want;
      this.events.push({ k: 'shrink', n: want, of: C.SHRINK_STEPS });
    }
    const target = want / C.SHRINK_STEPS;
    if (this.zoneProgress < target) {
      const rate = (1 / C.SHRINK_STEPS) / C.ZONE_EASE;
      this.zoneProgress = Math.min(target, this.zoneProgress + rate * dt);
      this._recoverStrandedPowerups();
    }
  }

  /**
   * Crates never expire, so a closing boundary must not simply strand them
   * where nobody can reach them. Anything left outside is carried back into
   * the battle area rather than destroyed.
   */
  _recoverStrandedPowerups() {
    for (const p of this.powerups) {
      if (this.inZone(p.x, p.y, 0)) continue;
      const spot = this._findOpenWater(60, 0);
      if (spot) {
        p.x = spot.x + rand(-40, 40);
        p.y = spot.y + rand(-40, 40);
      } else {
        // Nowhere obvious: drag it back over the boundary.
        const z = this.zone;
        p.x = clamp(p.x, z[0] + 60, z[2] - 60);
        p.y = clamp(p.y, z[1] + 60, z[3] - 60);
        if (this.isLand(p.x, p.y)) {
          p.x = (z[0] + z[2]) / 2;
          p.y = (z[1] + z[3]) / 2;
        }
      }
      this.events.push({ k: 'puMove', x: round1(p.x), y: round1(p.y) });
    }
  }

  _updateWind(dt) {
    if (this.time >= this.windChangeAt) {
      // Pick a new nearby target so shifts feel gradual, never instant.
      this.windTargetDir = this.windDir + rand(-1.25, 1.25);
      // Skewed upwards, so long slack spells are rare.
      this.windTargetStrength = C.WIND_MIN +
        (C.WIND_MAX - C.WIND_MIN) * Math.pow(Math.random(), 0.6);
      this.windChangeAt = this.time + rand(C.WIND_CHANGE_EVERY[0], C.WIND_CHANGE_EVERY[1]);
      this.events.push({ k: 'wind' });
    }
    const dd = angDiff(this.windTargetDir, this.windDir);
    const step = C.WIND_TURN * dt;
    this.windDir += clamp(dd, -step, step);
    this.windDir = ((this.windDir % TAU) + TAU) % TAU;
    this.windStrength += clamp(this.windTargetStrength - this.windStrength, -0.05 * dt, 0.05 * dt);
    this.windStrength = clamp(this.windStrength, C.WIND_MIN, C.WIND_MAX);
  }

  /** How well a heading sails in the current wind: 0.30 (beating) .. 1.0 (running). */
  sailEfficiency(heading) {
    const c = Math.cos(heading - this.windDir);
    return 0.36 + 0.64 * Math.pow((c + 1) / 2, 0.85);
  }

  _updateShips(dt) {
    const now = this.time;
    for (const s of this.ships.values()) {
      if (!s.alive) continue;

      const stunned = now < s.stunUntil;

      // Steering - a ship with no way on answers the helm poorly.
      if (!stunned && s.input.turn) {
        const way = clamp(Math.abs(s.speed) / C.BASE_SPEED, 0, 1);
        s.angle += s.input.turn * C.TURN_RATE * (0.32 + 0.68 * way) * dt;
        s.angle = ((s.angle % TAU) + TAU) % TAU;
      }

      // Boost: a short sprint on a reserve that refills slowly. It multiplies
      // whatever the wind is giving you, so it will also drag you off a lee
      // shore when you are beating and slow.
      const wantBoost = s.input.boost && !stunned &&
        (s.boosting ? s.boost > 0 : s.boost >= C.BOOST_MIN_START);
      s.boosting = wantBoost;
      if (wantBoost) {
        s.boost = Math.max(0, s.boost - dt / C.BOOST_SECONDS);
      } else {
        s.boost = Math.min(1, s.boost + dt / C.BOOST_REFILL);
      }

      // Speed is entirely wind-driven: no throttle, only heading choice.
      // Even the lightest breeze still pushes her along decently; the wind
      // shifting is meant to change your best heading, not becalm you.
      const strength = 0.58 + 0.42 * this.windStrength;
      const boostMult = s.boosting ? C.BOOST_MULT : 1;
      const target = stunned ? 0
        : C.BASE_SPEED * this.sailEfficiency(s.angle) * strength * s.sailMult * boostMult;
      // Coming off the boost, she carries her way rather than stopping dead.
      const accel = (s.speed > target) ? C.ACCEL * 0.35 : C.ACCEL;
      s.speed += (target - s.speed) * Math.min(1, accel * dt);

      // Left alone long enough, the crew start patching her up.
      if (s.isRegenerating(now)) {
        s.hp = Math.min(C.SHIP_HP, s.hp + C.REGEN_RATE * dt);
      }

      let nx = s.x + Math.cos(s.angle) * s.speed * dt;
      let ny = s.y + Math.sin(s.angle) * s.speed * dt;

      // Whirlpool suction
      for (const w of this.whirlpools) {
        const dx = w.x - s.x, dy = w.y - s.y;
        const d = Math.hypot(dx, dy) || 0.001;
        if (d > w.r) continue;
        // f^1.5 rather than f^2: the outer rim is escapable under sail,
        // but past roughly half way in the suction beats any ship's speed.
        const f = 1 - d / w.r;
        const pull = C.WHIRL_PULL * Math.pow(f, 1.5) * dt;
        nx += (dx / d) * pull;
        ny += (dy / d) * pull;
        // tangential component, so ships visibly spiral in
        const tx = -dy / d, ty = dx / d;
        nx += tx * pull * C.WHIRL_SWIRL;
        ny += ty * pull * C.WHIRL_SWIRL;
        s.angle += 1.6 * f * dt;

        if (d < C.WHIRL_CORE) {
          s.hp -= C.WHIRL_DPS * dt;
          this.markCombat(s);
          if (s.hp <= 0) { this.sink(s, null, 'whirlpool'); break; }
        }
      }
      if (!s.alive) continue;

      // Caught outside the closing battle area: she goes down fast, but
      // there is just enough time to run back in.
      if (!this.inZone(nx, ny, 0)) {
        s.hp -= C.OUTSIDE_DPS * dt;
        this.markCombat(s);
        if (s.hp <= 0) { this.sink(s, null, 'outside'); continue; }
      }

      // Map edge - the ship simply stops.
      const pad = C.SHIP_HALF_LEN;
      if (nx < pad) { nx = pad; s.speed = 0; }
      if (ny < pad) { ny = pad; s.speed = 0; }
      if (nx > C.WORLD - pad) { nx = C.WORLD - pad; s.speed = 0; }
      if (ny > C.WORLD - pad) { ny = C.WORLD - pad; s.speed = 0; }

      // Running aground
      const bowX = nx + Math.cos(s.angle) * C.SHIP_HALF_LEN;
      const bowY = ny + Math.sin(s.angle) * C.SHIP_HALF_LEN;
      if (this.isLand(bowX, bowY) || this.isLand(nx, ny)) {
        s.speed = 0;
        s.stunUntil = now + C.STUN_TIME;
        // Shove the hull back off the beach.
        nx = s.x - Math.cos(s.angle) * 14;
        ny = s.y - Math.sin(s.angle) * 14;
        if (now - s.groundHitAt > C.GROUND_COOLDOWN) {
          s.groundHitAt = now;
          s.hp -= C.GROUND_DAMAGE;
          this.markCombat(s);
          this.events.push({ k: 'ground', x: round1(bowX), y: round1(bowY) });
          if (s.hp <= 0) { this.sink(s, null, 'ground'); continue; }
        }
      }

      s.x = nx; s.y = ny;

      // Gunnery
      if (s.input.fire && now >= s.reloadAt) this.fireBroadside(s);
    }
  }

  fireBroadside(s) {
    const now = this.time;
    s.reloadAt = now + s.reloadTime;
    this.markCombat(s);
    const perp = s.angle + s.side * Math.PI / 2;
    const n = s.cannons;
    const maxDist = C.RANGE;
    const superShot = s.isSuper(now);

    for (let i = 0; i < n; i++) {
      // Spread the gun ports evenly along the hull.
      const t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
      const along = t * (C.SHIP_HALF_LEN - 8);
      const ox = Math.cos(s.angle) * along + Math.cos(perp) * (C.SHIP_HALF_BEAM + 4);
      const oy = Math.sin(s.angle) * along + Math.sin(perp) * (C.SHIP_HALF_BEAM + 4);
      const dir = perp + (Math.random() - 0.5) * 2 * C.SPREAD;

      this.projectiles.push({
        id: eid(),
        owner: s.id,
        team: s.team,
        x: s.x + ox,
        y: s.y + oy,
        vx: Math.cos(dir) * C.BALL_SPEED,
        vy: Math.sin(dir) * C.BALL_SPEED,
        travelled: 0,
        maxDist: maxDist * rand(0.96, 1.04),
        damage: C.BALL_DAMAGE * (superShot ? C.SUPER_MULT : 1),
        superShot: superShot,
        age: 0
      });
    }

    this.events.push({
      k: 'fire',
      x: round1(s.x), y: round1(s.y),
      a: round3(perp), n: n, s: superShot ? 1 : 0
    });
  }

  _updateProjectiles(dt) {
    const out = [];
    for (const p of this.projectiles) {
      p.age += dt;
      let remaining = Math.hypot(p.vx, p.vy) * dt;
      const stepLen = 7;                     // sub-step so fast balls can't tunnel
      const ux = p.vx / C.BALL_SPEED, uy = p.vy / C.BALL_SPEED;
      let dead = false;

      while (remaining > 0 && !dead) {
        const d = Math.min(stepLen, remaining);
        remaining -= d;
        p.x += ux * d; p.y += uy * d;
        p.travelled += d;

        if (p.x < 0 || p.y < 0 || p.x > C.WORLD || p.y > C.WORLD) {
          this.events.push({ k: 'splash', x: round1(p.x), y: round1(p.y) });
          dead = true; break;
        }

        // High ground stops a shot dead; flat land it simply flies over.
        if (this.blocksShot(p.x, p.y)) {
          this.events.push({ k: 'rock', x: round1(p.x), y: round1(p.y) });
          dead = true; break;
        }

        if (p.age > 0.05) {
          for (const s of this.ships.values()) {
            if (!s.alive || s.id === p.owner) continue;
            if (this.time < s.protectUntil) continue;
            if (!s.contains(p.x, p.y, 0)) continue;

            s.hp -= p.damage;
            this.markCombat(s);
            this.markCombat(this.ships.get(p.owner));
            this.events.push({
              k: 'hit', x: round1(p.x), y: round1(p.y), s: p.superShot ? 1 : 0
            });
            if (s.hp <= 0) this.sink(s, this.ships.get(p.owner) || null, 'shot');
            dead = true; break;
          }
        }
        if (dead) break;

        if (p.travelled >= p.maxDist) {
          const onLand = this.isLand(p.x, p.y);
          this.events.push({ k: onLand ? 'dirt' : 'splash', x: round1(p.x), y: round1(p.y) });
          dead = true; break;
        }
      }

      if (!dead) out.push(p);
    }
    this.projectiles = out;
  }

  // ---- sinking & drops ------------------------------------------------

  sink(victim, killer, cause) {
    if (!victim.alive) return;
    victim.alive = false;
    victim.hp = 0;
    victim.deaths++;
    victim.speed = 0;
    victim.respawnAt = this.time + C.RESPAWN_DELAY;

    let teamKill = false;
    if (killer && killer.id !== victim.id) {
      if (this.mode === C.MODE_TDM && killer.team === victim.team) {
        killer.score -= 1;                    // a team kill costs you a point
        teamKill = true;
      } else {
        killer.score += 1;
        killer.kills++;
      }
    }

    this.dropPowerups(victim);

    this.events.push({
      k: 'sink',
      x: round1(victim.x), y: round1(victim.y), a: round3(victim.angle),
      v: victim.id,
      by: killer ? killer.id : 0,
      c: cause,
      tk: teamKill ? 1 : 0
    });
  }

  /**
   * A sinking ship spills up to three of the power-ups it was carrying - and
   * if it was carrying none, it still leaves one random crate behind, so
   * every wreck is worth sailing over.
   */
  dropPowerups(ship) {
    const pool = ship.powerups.slice();
    const drops = [];

    if (pool.length) {
      const n = Math.min(C.DROP_MAX, pool.length);
      for (let i = 0; i < n; i++) drops.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
    } else {
      drops.push(this._randomPowerupType());
    }

    for (const type of drops) {
      const a = Math.random() * TAU;
      const dist = rand(24, 78);
      let x = clamp(ship.x + Math.cos(a) * dist, 30, C.WORLD - 30);
      let y = clamp(ship.y + Math.sin(a) * dist, 30, C.WORLD - 30);
      if (this.isLand(x, y)) { x = ship.x; y = ship.y; }
      this.powerups.push({ id: eid(), type, x, y, dropped: true });
    }
    ship.powerups = [];

    // Safety ceiling only - the oldest crates give way, never on a timer.
    while (this.powerups.length > C.PU_HARD_MAX) this.powerups.shift();
  }

  _updateRespawns() {
    for (const s of this.ships.values()) {
      if (s.alive || this.time < s.respawnAt) continue;
      const sp = this.chooseSpawn(s.team);
      s.resetForSpawn(sp.x, sp.y, sp.angle, this.time);
      this.events.push({ k: 'spawn', x: round1(s.x), y: round1(s.y), v: s.id });
    }
  }

  // ---- whirlpools -----------------------------------------------------

  _updateWhirlpools(dt) {
    this.whirlpools = this.whirlpools.filter((w) => {
      w.age += dt;
      w.phase = (w.phase + dt * 1.1) % TAU;
      return w.age < w.life;
    });

    if (this.time >= this.nextWhirlAt) {
      this.nextWhirlAt = this.time + rand(C.WHIRL_SPAWN[0], C.WHIRL_SPAWN[1]);
      // Once the battle area is well closed in there is no sea room left to
      // dodge one, so the whirlpools stop coming. Any already turning are
      // left to spin themselves out.
      const stillSpawning = this.zoneShrinks <= C.WHIRL_LAST_AREA;
      if (stillSpawning && this.whirlpools.length < C.WHIRL_MAX) {
        const spot = this._findOpenWater(C.WHIRL_RADIUS * 0.8, C.WORLD * 0.135);
        if (spot) {
          this.whirlpools.push({
            id: eid(), x: spot.x, y: spot.y,
            r: C.WHIRL_RADIUS * rand(0.85, 1.15),
            age: 0, life: C.WHIRL_LIFE * rand(0.8, 1.25),
            phase: 0
          });
          this.events.push({ k: 'whirl', x: round1(spot.x), y: round1(spot.y) });
        }
      }
    }
  }

  _findOpenWater(clearRadius, minShipDist) {
    for (let attempt = 0; attempt < 70; attempt++) {
      const cand = this.spawns.length ? pick(this.spawns) : null;
      if (!cand) return null;
      // No point putting anything where the battle area no longer reaches.
      if (!this.inZone(cand.x, cand.y, clearRadius * 0.5)) continue;
      let ok = true;
      // Keep clear of land
      for (let a = 0; a < TAU; a += Math.PI / 6) {
        if (this.isLand(cand.x + Math.cos(a) * clearRadius, cand.y + Math.sin(a) * clearRadius)) { ok = false; break; }
      }
      if (!ok) continue;
      if (minShipDist) {
        for (const s of this.ships.values()) {
          if (s.alive && Math.hypot(s.x - cand.x, s.y - cand.y) < minShipDist) { ok = false; break; }
        }
      }
      if (ok) return cand;
    }
    return null;
  }

  // ---- power-ups ------------------------------------------------------

  _randomPowerupType() {
    let total = 0;
    for (const [, w] of C.PU_WEIGHTS) total += w;
    let r = Math.random() * total;
    for (const [type, w] of C.PU_WEIGHTS) { r -= w; if (r <= 0) return type; }
    return C.PU_WEIGHTS[0][0];
  }

  _updatePowerups(dt) {
    // Power-ups are permanent: once one is floating, it waits to be taken.
    // The only bound is the spawner's cap, plus a safety ceiling so a long
    // match full of sink drops cannot grow the world state without limit.
    if (this.time >= this.nextPowerupAt) {
      this.nextPowerupAt = this.time + rand(C.PU_SPAWN[0], C.PU_SPAWN[1]);
      if (this.powerups.length < C.PU_MAX) {
        const spot = this._findOpenWater(60, 0);
        if (spot) {
          this.powerups.push({
            id: eid(),
            type: this._randomPowerupType(),
            x: spot.x + rand(-60, 60),
            y: spot.y + rand(-60, 60),
            dropped: false
          });
        }
      }
    }

    // pickup
    for (const s of this.ships.values()) {
      if (!s.alive) continue;
      for (let i = this.powerups.length - 1; i >= 0; i--) {
        const p = this.powerups[i];
        if (Math.hypot(p.x - s.x, p.y - s.y) > C.PU_RADIUS + C.SHIP_HALF_LEN * 0.55) continue;
        this.powerups.splice(i, 1);
        this.applyPowerup(s, p.type);
        this.events.push({ k: 'pickup', x: round1(p.x), y: round1(p.y), p: p.type, v: s.id });
      }
    }
  }

  applyPowerup(s, type) {
    switch (type) {
      case C.PU.SAIL:
        if (s.sailStacks < C.SAIL_MAX_STACK) { s.sailStacks++; s.powerups.push(type); }
        break;
      case C.PU.CANNON:
        if (s.cannons < C.CANNONS_MAX) { s.cannons++; s.powerups.push(type); }
        break;
      case C.PU.SUPER:
        s.superUntil = Math.max(s.superUntil, this.time) + C.SUPER_TIME;
        s.powerups.push(type);
        break;
      case C.PU.RAPID:
        if (s.rapidStacks < C.RAPID_MAX_STACK) { s.rapidStacks++; s.powerups.push(type); }
        break;
      case C.PU.REPAIR_S:
        s.hp = Math.min(C.SHIP_HP, s.hp + C.REPAIR_S_AMOUNT);
        break;
      case C.PU.REPAIR_L:
        s.hp = Math.min(C.SHIP_HP, s.hp + C.REPAIR_L_AMOUNT);
        break;
    }
  }

  // ---- ship vs ship ---------------------------------------------------

  _updateCollisions() {
    const list = [...this.ships.values()].filter((s) => s.alive);
    const now = this.time;

    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d > C.SHIP_LEN + 6) continue;

        const aBowX = a.x + Math.cos(a.angle) * C.SHIP_HALF_LEN;
        const aBowY = a.y + Math.sin(a.angle) * C.SHIP_HALF_LEN;
        const bBowX = b.x + Math.cos(b.angle) * C.SHIP_HALF_LEN;
        const bBowY = b.y + Math.sin(b.angle) * C.SHIP_HALF_LEN;

        const aRams = b.contains(aBowX, aBowY, 2);
        const bRams = a.contains(bBowX, bBowY, 2);
        if (!aRams && !bRams && d > C.SHIP_LEN * 0.72) continue;

        // Both ships sit out the grace period, so grinding hulls together
        // cannot chip anyone down and nobody can be chain-rammed.
        const fresh = (s) => now - s.collideAt > C.COLLIDE_COOLDOWN;

        // The stun and the dead stop are applied ONCE per collision, not on
        // every tick the hulls happen to overlap. Re-applying them each tick
        // pinned both ships at zero speed against each other and they could
        // never come apart again.
        if (aRams && bRams) {
          if (fresh(a) && fresh(b)) {
            // Bow to bow: both ships simply stop dead.
            a.collideAt = b.collideAt = now;
            a.speed = 0; b.speed = 0;
            a.stunUntil = now + C.STUN_TIME;
            b.stunUntil = now + C.STUN_TIME;
            a.hp -= C.HEADON_DAMAGE; b.hp -= C.HEADON_DAMAGE;
            this.markCombat(a); this.markCombat(b);
            this.events.push({ k: 'headon', x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) });
          }
        } else if (aRams || bRams) {
          const rammer = aRams ? a : b;
          const victim = aRams ? b : a;
          if (fresh(rammer) && fresh(victim)) {
            rammer.collideAt = now;
            victim.collideAt = now;
            rammer.speed *= 0.35;
            victim.stunUntil = now + C.STUN_TIME * 0.6;
            victim.hp -= C.RAM_DAMAGE;
            rammer.hp -= C.RAM_SELF_DAMAGE;
            this.markCombat(victim); this.markCombat(rammer);
            this.events.push({
              k: 'ram',
              x: round1(aRams ? aBowX : bBowX),
              y: round1(aRams ? aBowY : bBowY)
            });
            if (victim.hp <= 0) this.sink(victim, rammer, 'ram');
            if (rammer.hp <= 0) this.sink(rammer, null, 'ram');
          }
        }

        this._separate(a, b, d);
      }
    }
  }

  /**
   * How far this hull reaches in a given world direction. A ship is an
   * ellipse, so a bow-on neighbour has to be much further away than one
   * alongside - separating on a single circular radius left two ships that
   * met bow to bow deeply overlapped, and stuck there.
   */
  _hullReach(ship, dirAngle) {
    const t = dirAngle - ship.angle;
    const ax = C.SHIP_HALF_LEN, by = C.SHIP_HALF_BEAM;
    const ct = Math.cos(t), st = Math.sin(t);
    return (ax * by) / Math.sqrt(by * by * ct * ct + ax * ax * st * st);
  }

  _separate(a, b, d) {
    let nx, ny;
    if (d < 0.001) {
      // Exactly on top of each other: shove them apart any which way.
      const rnd = Math.random() * TAU;
      nx = Math.cos(rnd); ny = Math.sin(rnd);
      d = 0.001;
    } else {
      nx = (a.x - b.x) / d; ny = (a.y - b.y) / d;
    }

    const toB = Math.atan2(b.y - a.y, b.x - a.x);
    const minD = this._hullReach(a, toB) + this._hullReach(b, toB + Math.PI) + 2;
    if (d >= minD) return;

    // Push all the way clear, not halfway, or they creep back together.
    const push = (minD - d) / 2;
    a.x = clamp(a.x + nx * push, 30, C.WORLD - 30);
    a.y = clamp(a.y + ny * push, 30, C.WORLD - 30);
    b.x = clamp(b.x - nx * push, 30, C.WORLD - 30);
    b.y = clamp(b.y - ny * push, 30, C.WORLD - 30);

    // Bleed off the part of each ship's way that is driving her into the
    // other, so they slide apart instead of grinding together.
    const intoB = Math.cos(a.angle - toB);
    if (intoB > 0) a.speed *= 1 - 0.5 * intoB;
    const intoA = Math.cos(b.angle - (toB + Math.PI));
    if (intoA > 0) b.speed *= 1 - 0.5 * intoA;
  }

  // ---- serialisation --------------------------------------------------

  /** Final table at the end of a round, best first. */
  standings() {
    const rows = [];
    for (const s of this.ships.values()) {
      rows.push({
        id: s.id, name: s.name, team: s.team, colorIdx: s.colorIdx,
        bot: s.isBot ? 1 : 0, score: s.score, kills: s.kills, deaths: s.deaths
      });
    }
    rows.sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }

  mapPayload() {
    return { def: this.def, decor: this.decor, mode: this.mode };
  }

  roster() {
    const out = [];
    for (const s of this.ships.values()) {
      out.push({
        i: s.id, n: s.name, t: s.team, c: s.colorIdx, b: s.isBot ? 1 : 0
      });
    }
    return out;
  }

  snapshot() {
    const now = this.time;
    const ships = [];
    for (const s of this.ships.values()) {
      ships.push([
        s.id,
        round1(s.x), round1(s.y), round3(s.angle),
        Math.max(0, Math.round(s.hp)),
        s.side, s.cannons, s.sailStacks,
        s.isSuper(now) ? Math.round((s.superUntil - now) * 10) / 10 : 0,
        s.alive ? 1 : 0,
        s.alive ? 0 : Math.max(0, Math.round((s.respawnAt - now) * 10) / 10),
        Math.max(0, Math.min(1, Math.round((1 - (s.reloadAt - now) / s.reloadTime) * 100) / 100)),
        s.score,
        now < s.protectUntil ? 1 : 0,
        Math.round(s.speed),
        Math.round(s.boost * 100) / 100,
        s.boosting ? 1 : 0,
        s.rapidStacks,
        s.isRegenerating(now) ? 1 : 0
      ]);
    }

    const pr = this.projectiles.map((p) => [p.id, round1(p.x), round1(p.y), Math.round(p.vx), Math.round(p.vy), p.superShot ? 1 : 0, Math.round(Math.min(1, p.travelled / p.maxDist) * 100) / 100]);
    const pu = this.powerups.map((p) => [p.id, round1(p.x), round1(p.y), p.type]);
    const wp = this.whirlpools.map((w) => [w.id, round1(w.x), round1(w.y), Math.round(w.r), round3(w.phase), Math.round(Math.min(1, (w.life - w.age) / 2) * 100) / 100]);

    const ev = this.events.slice(0, 80);
    this.events.length = 0;

    const z = this.zone;
    return {
      t: 's',
      k: this.tick,
      w: [round3(this.windDir), round3(this.windStrength)],
      rt: Math.round(this.timeLeft * 10) / 10,
      sz: [Math.round(z[0]), Math.round(z[1]), Math.round(z[2]), Math.round(z[3])],
      sn: this.zoneShrinks,
      sh: ships, pr, pu, wp, ev
    };
  }
}

module.exports = { Game, Ship, angDiff, clamp, TAU };
