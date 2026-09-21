/* Super Sinky - bot captains.
 *
 * Bots drive a normal Ship through the exact same input struct a human uses,
 * so they obey wind, run aground and drown in whirlpools like anybody else.
 */
'use strict';

const C = require('../shared/constants.js');
const { angDiff, clamp, TAU } = require('./game.js');

const BOT_NAMES = [
  'Blackbeard', 'Anne Bonny', 'Calico Jack', 'Mary Read', 'Barbarossa',
  'Grace O\'Malley', 'Henry Every', 'Kidd', 'Rackham', 'Morgan',
  'Roberts', 'Vane', 'Teach', 'Hornigold', 'Bellamy', 'Ching Shih'
];

let nameCursor = 0;
function botName(taken) {
  for (let i = 0; i < BOT_NAMES.length * 2; i++) {
    const n = BOT_NAMES[nameCursor++ % BOT_NAMES.length];
    if (!taken.has(n)) return n;
  }
  return 'Bot ' + (nameCursor++);
}

class BotBrain {
  constructor(ship) {
    this.ship = ship;
    this.think = 0;                  // countdown to next decision
    this.targetId = 0;
    this.puId = 0;
    this.aimError = (Math.random() - 0.5) * 0.10;
    this.skill = 0.65 + Math.random() * 0.35;
    this.evadeUntil = 0;
    this.evadeTurn = 1;
    this.wander = Math.random() * TAU;
    this.zoneRun = false;
  }

  update(game, dt) {
    const s = this.ship;
    if (!s.alive) { s.input.turn = 0; s.input.fire = false; s.input.boost = false; return; }

    this.think -= dt;
    if (this.think <= 0) {
      this.think = 0.12 + Math.random() * 0.12;   // ~8 decisions a second
      this.decide(game);
    }
  }

  decide(game) {
    const s = this.ship;

    const hazard = this.hazardTurn(game);
    if (hazard !== null) {
      s.input.turn = hazard;
      s.input.fire = false;
      // Claw off a whirlpool, or back inside the battle area.
      s.input.boost = this.zoneRun || this.nearWhirlpool(game);
      return;
    }

    const target = this.pickTarget(game);
    const pu = this.pickPowerup(game);

    let desiredHeading = null;
    let fire = false;

    if (target) {
      const dx = target.x - s.x, dy = target.y - s.y;
      const dist = Math.hypot(dx, dy);
      const toTarget = Math.atan2(dy, dx);

      // A ball can be over a second in the air, so aim where the enemy
      // will be, not where it is.
      const aim = this.intercept(s, target);

      // Present whichever broadside is already closer to bearing.
      const port = angDiff(aim.angle, s.angle - Math.PI / 2);
      const stbd = angDiff(aim.angle, s.angle + Math.PI / 2);
      s.side = Math.abs(stbd) <= Math.abs(port) ? 1 : -1;
      const bearing = s.side === 1 ? stbd : port;

      // Hold a course that keeps the guns bearing, edging in or out to
      // settle at a fighting range. Closing in matters twice over: the shot
      // flies for less time, and the arc the guns can bear through is wider.
      // A hurt bot stands off near the limit of the guns instead.
      const ideal = s.hp > 45 ? C.RANGE * 0.45 : C.RANGE * 0.9;
      const closing = clamp((dist - ideal) / 400, -1, 1);
      desiredHeading = toTarget - s.side * (Math.PI / 2) * (1 - closing * 0.8);

      // Tolerance shrinks with range - a distant target needs finer aim.
      const tol = Math.atan2(26, Math.max(70, aim.dist)) + 0.05 + (1 - this.skill) * 0.06;
      const inArc = Math.abs(bearing + this.aimError) < tol;
      const inRange = aim.dist < C.RANGE && aim.dist > 55;
      const clearShot = game.hasLineOfFire(s.x, s.y, aim.x, aim.y);
      fire = inArc && inRange && clearShot && !this.friendlyInLine(game, aim);

      // A badly hurt bot breaks off downwind to look for repairs.
      if (s.hp < 30 && Math.random() < 0.5) {
        desiredHeading = game.windDir;
      }
    }

    // Detour for a power-up when it is roughly on the way, or always when
    // there is nobody to fight.
    if (pu) {
      const toPu = Math.atan2(pu.y - s.y, pu.x - s.x);
      if (desiredHeading === null || Math.abs(angDiff(toPu, desiredHeading)) < 1.3) {
        desiredHeading = toPu;
      }
    }

    if (desiredHeading === null) {
      // Nothing to do: cruise, favouring a fast point of sail.
      this.wander += (Math.random() - 0.5) * 0.4;
      desiredHeading = game.windDir + Math.sin(this.wander) * 1.1;
    }

    // Never let a chase draw her outside the battle area.
    const zone2 = game.zone;
    const ahead = 200;
    const px = s.x + Math.cos(desiredHeading) * ahead;
    const py = s.y + Math.sin(desiredHeading) * ahead;
    if (!game.inZone(px, py, C.ZONE_WARN * 0.5)) {
      desiredHeading = Math.atan2((zone2[1] + zone2[3]) / 2 - s.y, (zone2[0] + zone2[2]) / 2 - s.x);
      fire = false;
    }

    s.input.turn = this.steerTo(this.navigable(game, desiredHeading));
    s.input.fire = fire;
    s.input.boost = this.wantBoost(game, target);
  }

  /** Spend the reserve on getting away, or on closing a long gap. */
  wantBoost(game, target) {
    const s = this.ship;
    if (s.boost < (s.boosting ? 0.02 : 0.35)) return false;
    if (this.nearWhirlpool(game)) return true;
    if (!target) return false;

    const dist = Math.hypot(target.x - s.x, target.y - s.y);
    if (s.hp < 35) return true;                    // running for her life
    if (dist > C.RANGE * 1.25) return true;        // too far to be any use
    return false;
  }

  nearWhirlpool(game) {
    const s = this.ship;
    for (const w of game.whirlpools) {
      if (Math.hypot(w.x - s.x, w.y - s.y) < w.r * 1.5) return true;
    }
    return false;
  }

  /** Where to point the guns so the shot and the target arrive together. */
  intercept(s, t) {
    let px = t.x, py = t.y;
    for (let i = 0; i < 3; i++) {
      const d = Math.hypot(px - s.x, py - s.y);
      const flight = d / C.BALL_SPEED;
      px = t.x + Math.cos(t.angle) * t.speed * flight;
      py = t.y + Math.sin(t.angle) * t.speed * flight;
    }
    const d = Math.hypot(px - s.x, py - s.y);
    return { x: px, y: py, dist: d, angle: Math.atan2(py - s.y, px - s.x) };
  }

  /**
   * Bend a desired course around anything solid. hazardTurn only reacts once
   * the bow is already pointed at a beach; this stops a bot from ever
   * choosing such a course while it chases a target or a crate.
   */
  navigable(game, heading) {
    const s = this.ship;
    const look = clamp(150 + Math.abs(s.speed) * 1.4, 170, 340);
    if (this.freeDistance(game, heading, look) >= look) return heading;

    let bestHeading = heading, bestRoom = -1;
    for (let off = 0.3; off <= 2.1; off += 0.3) {
      for (const dir of [1, -1]) {
        const cand = heading + off * dir;
        const room = this.freeDistance(game, cand, look);
        if (room >= look) return cand;          // properly clear, take it
        if (room > bestRoom) { bestRoom = room; bestHeading = cand; }
      }
    }
    return bestHeading;                          // nowhere is clear: most room wins
  }

  steerTo(heading) {
    const d = angDiff(heading, this.ship.angle);
    if (Math.abs(d) < 0.06) return 0;
    return d > 0 ? 1 : -1;
  }

  /** Returns a turn direction when land, the map edge or a whirlpool looms. */
  hazardTurn(game) {
    const s = this.ship;
    const now = game.time;
    if (now < this.evadeUntil) return this.evadeTurn;

    // The closing battle area comes first: everything else is survivable.
    const zone = game.zone;
    const pad = C.ZONE_WARN;
    if (s.x < zone[0] + pad || s.y < zone[1] + pad ||
        s.x > zone[2] - pad || s.y > zone[3] - pad) {
      const cx = (zone[0] + zone[2]) / 2, cy = (zone[1] + zone[3]) / 2;
      const inward = Math.atan2(cy - s.y, cx - s.x);
      // Heading for the middle is no good if it puts her on a beach, so the
      // inward course goes through the same land check as any other.
      const course = this.navigable(game, inward);
      const outside = !game.inZone(s.x, s.y, 0);
      this.evadeUntil = now + (outside ? 0.35 : 0.5);
      this.evadeTurn = this.steerTo(course);
      if (outside || Math.abs(angDiff(course, s.angle)) < 0.7) {
        // Only burn the reserve once she is actually pointing the right way.
        this.zoneRun = outside;
      }
      return this.evadeTurn;
    }
    this.zoneRun = false;

    // Whirlpools next - they are lethal and pull you in.
    for (const w of game.whirlpools) {
      const dx = w.x - s.x, dy = w.y - s.y;
      if (Math.hypot(dx, dy) < w.r * 1.6) {
        const away = Math.atan2(-dy, -dx);
        this.evadeUntil = now + 0.7;
        this.evadeTurn = angDiff(away, s.angle) > 0 ? 1 : -1;
        return this.evadeTurn;
      }
    }

    // A ship carries her way for a while, so look further the faster she
    // goes. Measured against grounding rate, a longer horizon than this is
    // counterproductive: close to an island almost every heading fails it,
    // and the bots end up oscillating instead of committing to a course.
    const look = clamp(160 + Math.abs(s.speed) * 1.7, 180, 400);
    if (this.freeDistance(game, s.angle, look) >= look) return null;

    // Steer for the most open water, preferring a small course change.
    const probes = [-0.35, 0.35, -0.7, 0.7, -1.1, 1.1, -1.6, 1.6, -2.3, 2.3];
    let best = null, bestScore = -Infinity;
    for (const off of probes) {
      const d = this.freeDistance(game, s.angle + off, look);
      const score = d - Math.abs(off) * 26;
      if (score > bestScore) { bestScore = score; best = off; }
    }

    this.evadeUntil = now + 0.5;
    this.evadeTurn = best > 0 ? 1 : -1;
    return this.evadeTurn;
  }

  /** How far the ship could run on this heading before hitting something. */
  freeDistance(game, angle, look) {
    const s = this.ship;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const edge = 110;
    for (let d = 40; d <= look; d += 26) {
      const px = s.x + ca * d, py = s.y + sa * d;
      if (px < edge || py < edge || px > C.WORLD - edge || py > C.WORLD - edge) return d;
      if (game.isLand(px, py)) return d;
    }
    return look;
  }

  pickTarget(game) {
    const s = this.ship;
    let best = null, bestScore = -Infinity;
    for (const o of game.ships.values()) {
      if (o.id === s.id || !o.alive) continue;
      if (game.mode === C.MODE_TDM && o.team === s.team) continue;
      if (game.time < o.protectUntil) continue;
      const d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d > 1800) continue;
      let score = 2200 - d;
      if (o.hp < 40) score += 500;                 // finish off the wounded
      if (o.id === this.targetId) score += 260;    // hysteresis
      if (score > bestScore) { bestScore = score; best = o; }
    }
    this.targetId = best ? best.id : 0;
    return best;
  }

  pickPowerup(game) {
    const s = this.ship;
    const wants = s.hp < 70;
    let best = null, bestD = Infinity;
    for (const p of game.powerups) {
      const d = Math.hypot(p.x - s.x, p.y - s.y);
      const reach = wants ? 900 : 480;
      if (d > reach) continue;
      const isRepair = p.type === C.PU.REPAIR_S || p.type === C.PU.REPAIR_L;
      if (wants && !isRepair) continue;
      if (d < bestD) { bestD = d; best = p; }
    }
    this.puId = best ? best.id : 0;
    return best;
  }

  /** Don't put a broadside through a team mate. */
  friendlyInLine(game, aim) {
    const s = this.ship;
    if (game.mode !== C.MODE_TDM) return false;
    const perp = s.angle + s.side * Math.PI / 2;
    const reach = C.RANGE;
    for (const o of game.ships.values()) {
      if (o.id === s.id || !o.alive || o.team !== s.team) continue;
      const dx = o.x - s.x, dy = o.y - s.y;
      const d = Math.hypot(dx, dy);
      if (d > reach) continue;
      const off = Math.abs(angDiff(Math.atan2(dy, dx), perp));
      if (off < Math.atan2(46, Math.max(40, d))) return true;
    }
    return false;
  }
}

module.exports = { BotBrain, botName };
