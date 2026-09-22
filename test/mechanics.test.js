/* Deterministic unit tests for Super Sinky game mechanics. */
'use strict';
const ROOT = require('path').join(__dirname, '..');
const C = require(ROOT + '/shared/constants.js');
const M = require(ROOT + '/shared/mapgen.js');
const { Game } = require(ROOT + '/server/game.js');

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) fails++;
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

const step = 1 / C.TICK_HZ;
function run(g, seconds) { for (let i = 0; i < seconds * C.TICK_HZ; i++) g.update(step); }
function drain(g) { const e = g.events.slice(); g.events.length = 0; return e; }

/**
 * The middle of the widest stretch of open sea on this map. Tests that let a
 * ship actually sail need somewhere she cannot wander ashore from.
 */
const _openWaterCache = new Map();
function openWater(g, minRadius) {
  const key = g.def.seed;
  let best = _openWaterCache.get(key);
  if (!best) {
    best = { x: C.WORLD / 2, y: C.WORLD / 2, r: 0 };
    for (let i = 0; i < g.spawns.length; i += 3) {
      const c = g.spawns[i];
      let r = 0;
      for (let d = 60; d <= 900; d += 40) {
        let clear = true;
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
          const px = c.x + Math.cos(a) * d, py = c.y + Math.sin(a) * d;
          if (px < 40 || py < 40 || px > C.WORLD - 40 || py > C.WORLD - 40 || g.isLand(px, py)) {
            clear = false; break;
          }
        }
        if (!clear) break;
        r = d;
      }
      if (r > best.r) best = { x: c.x, y: c.y, r };
    }
    _openWaterCache.set(key, best);
  }
  if (minRadius && best.r < minRadius) {
    throw new Error('no open water of radius ' + minRadius + ' (best ' + best.r + ')');
  }
  return best;
}

/** Advance the sim while pinning these ships in place (they still sail, but
 *  we do not want them wandering ashore during a long wait). */
function hold(g, ships, seconds) {
  const anchored = ships.map((z) => ({ s: z, x: z.x, y: z.y, a: z.angle }));
  for (let i = 0; i < seconds * C.TICK_HZ; i++) {
    g.update(step);
    for (const p of anchored) { p.s.x = p.x; p.s.y = p.y; p.s.angle = p.a; }
  }
}

function placeShip(g, id, name, team, x, y, angle) {
  const s = g.addShip(id, name, team, 0, false);
  s.x = x; s.y = y; s.angle = angle; s.speed = 0;
  s.protectUntil = 0; s.reloadAt = 0;
  return s;
}

// =====================================================================
section('wind and sailing');
{
  const g = new Game(C.MODE_DM, 4242);
  g.windDir = 0; g.windStrength = 1.0; g.windTargetStrength = 1.0; g.windTargetDir = 0;
  const w = openWater(g);

  check('the map has a wide berth to test in', w.r >= 300, 'clear radius ' + w.r);
  // Start them near the middle, heading outward, so 2s of sailing stays clear.
  const downwind = placeShip(g, 1, 'Down', -1, w.x - 120, w.y - 60, 0);   // running
  const upwind = placeShip(g, 2, 'Up', -1, w.x + 120, w.y, Math.PI);      // beating
  const beam = placeShip(g, 3, 'Beam', -1, w.x - 120, w.y + 60, Math.PI / 2); // reaching
  run(g, 2);
  check('none of them ran aground during the test',
    [downwind, upwind, beam].every((z) => z.hp === C.SHIP_HP),
    [downwind, upwind, beam].map((z) => Math.round(z.hp)).join('/'));
  check('efficiency ordering is correct',
    g.sailEfficiency(0) > g.sailEfficiency(Math.PI / 2) && g.sailEfficiency(Math.PI / 2) > g.sailEfficiency(Math.PI),
    [0, Math.PI / 2, Math.PI].map((a) => g.sailEfficiency(a).toFixed(2)).join(' > '));

  check('sailing downwind is fastest', downwind.speed > beam.speed && beam.speed > upwind.speed,
    'down=' + downwind.speed.toFixed(0) + ' beam=' + beam.speed.toFixed(0) + ' up=' + upwind.speed.toFixed(0));
  check('you can still make way against the wind', upwind.speed > 5, upwind.speed.toFixed(1));
  check('upwind is much slower than downwind', upwind.speed < downwind.speed * 0.5,
    (upwind.speed / downwind.speed).toFixed(2) + 'x');

  // Wind must drift, never jump.
  const g2 = new Game(C.MODE_DM, 77);
  let maxJump = 0, prev = g2.windDir;
  for (let i = 0; i < 60 * C.TICK_HZ; i++) {
    g2.update(step);
    let d = Math.abs(g2.windDir - prev);
    if (d > Math.PI) d = Math.PI * 2 - d;
    maxJump = Math.max(maxJump, d);
    prev = g2.windDir;
  }
  check('wind direction only drifts slowly', maxJump <= C.WIND_TURN * step + 1e-6,
    'max step=' + maxJump.toFixed(5) + ' rad/tick');
  check('wind strength stays in range', g2.windStrength >= C.WIND_MIN && g2.windStrength <= C.WIND_MAX,
    g2.windStrength.toFixed(2));
}

// =====================================================================
section('the round and the shrinking battle area');
{
  const g = new Game(C.MODE_DM, 4242);
  check('a round is ten minutes', C.ROUND_SECONDS === 600, C.ROUND_SECONDS + 's');
  check('the whole map is in play at the start',
    g.zone[0] === 0 && g.zone[2] === C.WORLD, g.zone.join(','));
  check('nothing has closed in yet', g.zoneShrinks === 0);

  // Nothing should happen for the first minute.
  run(g, C.SHRINK_START - 3);
  check('the area holds for the first minute', g.zoneShrinks === 0, g.zoneShrinks);

  // Then one step a minute, on the minute.
  const widths = [];
  let last = g.zone[2] - g.zone[0];
  for (let minute = 1; minute <= C.SHRINK_STEPS; minute++) {
    while (g.time < C.SHRINK_START + (minute - 1) * C.SHRINK_EVERY + C.ZONE_EASE + 1) g.update(step);
    const w = g.zone[2] - g.zone[0];
    widths.push(Math.round(w));
    if (w >= last) break;
    last = w;
  }
  check('it closes in once a minute', widths.length === C.SHRINK_STEPS,
    widths.length + ' steps: ' + widths.join(' -> '));
  // Width shrinks linearly with progress whatever the arena closes on.
  const stepWidth = (C.WORLD - C.WORLD * C.ZONE_FINAL) / C.SHRINK_STEPS;
  check('each step is a similar size',
    widths.every((v, i) => i === 0 || Math.abs((widths[i - 1] - v) - stepWidth) < 6),
    'steps of ~' + Math.round(stepWidth) + ': ' + widths.join(' -> '));

  // It eases in rather than jumping, so you can see it coming.
  const g2 = new Game(C.MODE_DM, 4242);
  run(g2, C.SHRINK_START + 0.2);
  const justAfter = g2.zone[2] - g2.zone[0];
  const oneStep = C.WORLD - stepWidth;
  check('the boundary eases in rather than snapping',
    justAfter > oneStep + 10, 'width ' + Math.round(justAfter) + ', one full step would be ' + Math.round(oneStep));
  run(g2, C.ZONE_EASE + 1);
  check('and it has settled a few seconds later',
    Math.abs((g2.zone[2] - g2.zone[0]) - oneStep) < 2,
    Math.round(g2.zone[2] - g2.zone[0]));

  // Closing on the middle of the map regularly produced an endgame arena
  // that was half island, so it now picks open water instead.
  let worstLand = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const gz = new Game(C.MODE_DM, seed * 911);
    const f = gz.zoneFinal;
    let land = 0, cells = 0;
    for (let y = f[1]; y <= f[3]; y += 25) {
      for (let x = f[0]; x <= f[2]; x += 25) { cells++; if (gz.isLand(x, y)) land++; }
    }
    worstLand = Math.max(worstLand, 100 * land / cells);
  }
  check('the final arena is open water, not an island', worstLand < 10,
    'worst across 8 maps: ' + worstLand.toFixed(1) + '% land');

  // It must also sit fully on the map.
  for (let seed = 1; seed <= 8; seed++) {
    const gz = new Game(C.MODE_DM, seed * 77);
    const f = gz.zoneFinal;
    if (f[0] < 0 || f[1] < 0 || f[2] > C.WORLD || f[3] > C.WORLD) {
      check('the final arena stays on the map', false, JSON.stringify(f));
      break;
    }
    if (seed === 8) check('the final arena stays on the map', true);
  }

  // The final arena.
  const g3 = new Game(C.MODE_DM, 4242);
  run(g3, C.ROUND_SECONDS - 1);
  const finalW = g3.zone[2] - g3.zone[0];
  check('there are seven areas, not nine', C.SHRINK_STEPS === 7, C.SHRINK_STEPS);
  check('the smallest area is the seventh',
    Math.abs((C.WORLD - C.SHRINK_STEPS * stepWidth) - C.WORLD * C.ZONE_FINAL) < 2,
    'area 7 is ' + Math.round(C.WORLD * C.ZONE_FINAL) + ' wide');
  check('the final area is not cramped', C.WORLD * C.ZONE_FINAL / C.RANGE >= 2,
    (C.WORLD * C.ZONE_FINAL / C.RANGE).toFixed(1) + 'x the gun range');
  // The last step fires at SHRINK_START + (steps - 1) * interval, then eases.
  const doneClosingAt = C.SHRINK_START + (C.SHRINK_STEPS - 1) * C.SHRINK_EVERY + C.ZONE_EASE;
  check('it stops closing with time left to fight in it',
    doneClosingAt < C.ROUND_SECONDS - 120,
    ((C.ROUND_SECONDS - doneClosingAt) / 60).toFixed(1) + ' minutes in the final area');

  check('the final area is about the configured fraction',
    Math.abs(finalW / C.WORLD - C.ZONE_FINAL) < 0.02,
    Math.round(finalW) + ' wide (' + (100 * finalW / C.WORLD).toFixed(0) + '% of the map)');
  check('the round is not over until the full ten minutes', !g3.isOver, g3.timeLeft.toFixed(1));
  run(g3, 2);
  check('the round ends after ten minutes', g3.isOver);
  check('time left bottoms out at zero', g3.timeLeft === 0);

  // Caught outside, she goes down.
  const g4 = new Game(C.MODE_DM, 4242);
  run(g4, C.SHRINK_START + C.ZONE_EASE + 2);
  const z = g4.zone;
  const stray = placeShip(g4, 1, 'Stray', -1, z[0] - 120, (z[1] + z[3]) / 2, 0);
  check('she is outside the area', !g4.inZone(stray.x, stray.y, 0));
  const hp0 = stray.hp;
  hold(g4, [stray], 1);
  check('being outside costs health', stray.hp < hp0, hp0 + ' -> ' + Math.round(stray.hp));
  const dps = (hp0 - stray.hp) / 1;
  check('it drains at roughly the configured rate', Math.abs(dps - C.OUTSIDE_DPS) < 4,
    dps.toFixed(0) + ' hp/s vs ' + C.OUTSIDE_DPS);
  check('there is time to run back in', C.SHIP_HP / C.OUTSIDE_DPS >= 3,
    (C.SHIP_HP / C.OUTSIDE_DPS).toFixed(1) + 's from full health');

  hold(g4, [stray], 5);
  check('staying outside sinks her', !stray.alive, 'hp=' + Math.round(stray.hp));
  const ev = drain(g4);
  check('the sinking is blamed on the area, not a player',
    ev.some((e) => e.k === 'sink' && e.c === 'outside' && e.by === 0));

  // A ship safely inside must be untouched.
  const g5 = new Game(C.MODE_DM, 4242);
  run(g5, C.SHRINK_START + C.ZONE_EASE + 2);
  const safe = placeShip(g5, 1, 'Safe', -1, C.WORLD / 2, C.WORLD / 2, 0);
  hold(g5, [safe], 3);
  check('a ship inside the area is untouched', safe.hp === C.SHIP_HP, safe.hp);

  // Whirlpools stop coming once the area is well closed in - there is no
  // longer the sea room to dodge one.
  const gw = new Game(C.MODE_DM, 4242);
  const spawnedIn = new Set();
  for (let i = 0; i < C.ROUND_SECONDS * C.TICK_HZ; i++) {
    gw.update(step);
    for (const e of gw.events) if (e.k === 'whirl') spawnedIn.add(gw.zoneShrinks);
    gw.events.length = 0;
  }
  const areas = [...spawnedIn].sort((x, y) => x - y);
  check('whirlpools appear in the early areas', areas.length > 1, 'areas ' + areas.join(', '));
  check('none appear from the fifth area onward',
    areas.every((n) => n <= C.WHIRL_LAST_AREA),
    'highest area with a new whirlpool: ' + Math.max.apply(null, areas));
  check('and none are still turning at the end', gw.whirlpools.length === 0,
    gw.whirlpools.length + ' left');

  // Respawns and crates must stay inside it.
  const g6 = new Game(C.MODE_DM, 4242);
  run(g6, C.ROUND_SECONDS - 30);
  let allIn = true;
  for (let i = 0; i < 80; i++) {
    const sp = g6.chooseSpawn(-1);
    if (!g6.inZone(sp.x, sp.y, 0)) { allIn = false; break; }
  }
  check('ships never respawn outside the battle area', allIn);
  check('crates are never left stranded outside it',
    g6.powerups.every((q) => g6.inZone(q.x, q.y, 0)),
    g6.powerups.length + ' crates');
  check('and none of them were destroyed to achieve that',
    g6.powerups.length === C.PU_MAX, g6.powerups.length + ' / ' + C.PU_MAX);
  check('whirlpools stay inside it too',
    g6.whirlpools.every((q) => g6.inZone(q.x, q.y, 0)));

  // The snapshot has to carry all of it.
  const snap = g6.snapshot();
  check('the snapshot reports the time left', typeof snap.rt === 'number' && snap.rt > 0, snap.rt);
  check('the snapshot reports the battle area', Array.isArray(snap.sz) && snap.sz.length === 4,
    JSON.stringify(snap.sz));
  check('the snapshot reports how far it has closed', snap.sn === C.SHRINK_STEPS, snap.sn);

  // Standings.
  const g7 = new Game(C.MODE_DM, 4242);
  const a = placeShip(g7, 1, 'Ahab', -1, 400, 400, 0);
  const b = placeShip(g7, 2, 'Bly', -1, 800, 400, 0);
  const c = placeShip(g7, 3, 'Cook', -1, 1200, 400, 0);
  g7.sink(b, a, 'shot');
  g7.sink(c, a, 'shot');
  g7.sink(a, b, 'shot');
  const table = g7.standings();
  check('standings are sorted best first', table[0].name === 'Ahab', table.map((r) => r.name + ':' + r.score).join(' '));
  check('standings carry kills and deaths',
    table[0].kills === 2 && table[0].deaths === 1,
    table[0].kills + 'k/' + table[0].deaths + 'd');
  check('every ship appears in the standings', table.length === 3, table.length);
}

// =====================================================================
section('boost');
{
  const g = new Game(C.MODE_DM, 4242);
  g.windDir = 0; g.windStrength = 1.0; g.windTargetStrength = 1.0; g.windTargetDir = 0;
  const w = openWater(g);
  const s = placeShip(g, 1, 'Sprinter', -1, w.x - 200, w.y, 0);

  run(g, 2);
  const cruise = s.speed;
  check('starts with a full reserve', s.boost === 1, s.boost);

  g.applyInput(1, { d: 0, f: false, s: 1, b: true });
  run(g, 1.2);
  check('boost makes her noticeably faster', s.speed > cruise * 1.4,
    cruise.toFixed(0) + ' -> ' + s.speed.toFixed(0) + ' (' + (s.speed / cruise).toFixed(2) + 'x)');
  check('boost is roughly the configured multiplier',
    Math.abs(s.speed / cruise - C.BOOST_MULT) < 0.15,
    (s.speed / cruise).toFixed(2) + ' vs ' + C.BOOST_MULT);
  check('the reserve drains while boosting', s.boost < 1, s.boost.toFixed(2));

  // Hold it down until it runs dry.
  let held = 1.2;
  while (s.boost > 0 && held < 8) { g.update(step); held += step; }
  check('the reserve lasts about the configured time',
    Math.abs(held - C.BOOST_SECONDS) < 0.5, held.toFixed(1) + 's vs ' + C.BOOST_SECONDS + 's');

  run(g, 1);
  check('an empty reserve stops boosting', !s.boosting);
  const drained = s.speed;

  // Let go and let it fill.
  g.applyInput(1, { d: 0, f: false, s: 1, b: false });
  let refill = 0;
  while (s.boost < 0.999 && refill < 30) { g.update(step); refill += step; }
  check('the reserve refills on its own',
    Math.abs(refill - C.BOOST_REFILL) < 1.5, refill.toFixed(1) + 's vs ' + C.BOOST_REFILL + 's');
  check('refilling is much slower than spending', C.BOOST_REFILL > C.BOOST_SECONDS * 3);

  // Boost must help you claw off a lee shore, so it multiplies a bad point
  // of sail too, not just a good one.
  const g2 = new Game(C.MODE_DM, 4242);
  g2.windDir = 0; g2.windStrength = 1; g2.windTargetStrength = 1; g2.windTargetDir = 0;
  const beat = placeShip(g2, 1, 'Beater', -1, w.x + 200, w.y, Math.PI);
  run(g2, 2);
  const slow = beat.speed;
  g2.applyInput(1, { d: 0, f: false, s: 1, b: true });
  run(g2, 1.2);
  check('boost also helps when beating into the wind', beat.speed > slow * 1.4,
    slow.toFixed(0) + ' -> ' + beat.speed.toFixed(0));

  // A stunned ship cannot boost out of trouble.
  const g3 = new Game(C.MODE_DM, 4242);
  const stunned = placeShip(g3, 1, 'Stuck', -1, w.x, w.y, 0);
  stunned.stunUntil = g3.time + 1;
  g3.applyInput(1, { d: 0, f: false, s: 1, b: true });
  run(g3, 0.4);
  check('a stunned ship cannot boost', !stunned.boosting && stunned.speed < 1,
    'speed=' + stunned.speed.toFixed(1));
}

// =====================================================================
section('out-of-combat repair');
{
  const g = new Game(C.MODE_DM, 4242);
  const w = openWater(g);
  const s = placeShip(g, 1, 'Patcher', -1, w.x, w.y, 0);
  s.hp = 40;
  s.combatAt = g.time;

  hold(g, [s], C.REGEN_DELAY - 2);
  check('no repairs before the delay is up', s.hp === 40, s.hp);
  check('not flagged as repairing yet', !s.isRegenerating(g.time));

  hold(g, [s], 4);
  check('starts repairing after the delay', s.hp > 40, '40 -> ' + Math.round(s.hp));
  check('flagged as repairing', s.isRegenerating(g.time));
  const rate = (s.hp - 40) / 2;
  check('repairs at roughly the configured rate', Math.abs(rate - C.REGEN_RATE) < 1.5,
    rate.toFixed(1) + ' hp/s vs ' + C.REGEN_RATE);

  hold(g, [s], 40);
  check('repairs stop at full health', s.hp === C.SHIP_HP, s.hp);
  check('a healthy ship is not flagged as repairing', !s.isRegenerating(g.time));

  // Firing restarts the clock.
  const g2 = new Game(C.MODE_DM, 4242);
  const s2 = placeShip(g2, 1, 'Gunner', -1, w.x, w.y, 0);
  s2.hp = 50;
  hold(g2, [s2], C.REGEN_DELAY + 3);
  check('an idle ship was repairing', s2.hp > 50, '50 -> ' + Math.round(s2.hp));
  const afterIdle = s2.hp;
  g2.fireBroadside(s2);
  hold(g2, [s2], C.REGEN_DELAY - 3);
  check('firing stops the repairs', Math.round(s2.hp) === Math.round(afterIdle),
    Math.round(afterIdle) + ' -> ' + Math.round(s2.hp));
  hold(g2, [s2], 5);
  check('repairs resume once she has been quiet again', s2.hp > afterIdle,
    Math.round(afterIdle) + ' -> ' + Math.round(s2.hp));

  // So does being hit.
  const g3 = new Game(C.MODE_DM, 4242);
  const shooter = placeShip(g3, 1, 'Shooter', -1, w.x, w.y, 0);
  const target = placeShip(g3, 2, 'Target', -1, w.x, w.y + 180, 0);
  target.hp = 50;
  hold(g3, [shooter, target], C.REGEN_DELAY + 2);
  const healed = target.hp;
  check('the target had started repairing', healed > 50 && healed < C.SHIP_HP,
    '50 -> ' + Math.round(healed));
  g3.applyInput(1, { d: 0, f: true, s: 1 });
  hold(g3, [shooter, target], 2);
  const hurt = target.hp;
  check('taking a hit stops the repairs', hurt < healed, Math.round(healed) + ' -> ' + Math.round(hurt));
  g3.applyInput(1, { d: 0, f: false, s: 1 });
  hold(g3, [shooter, target], C.REGEN_DELAY - 5);
  check('repairs stay stopped for the full delay after a hit',
    Math.round(target.hp) === Math.round(hurt), Math.round(target.hp));

  // A sunk ship must not quietly heal while waiting to respawn.
  const g4 = new Game(C.MODE_DM, 4242);
  const dead = placeShip(g4, 1, 'Dead', -1, w.x, w.y, 0);
  g4.sink(dead, null, 'shot');
  check('a sunk ship does not repair', !dead.isRegenerating(g4.time) && dead.hp === 0);
}

// =====================================================================
section('rapid fire');
{
  const g = new Game(C.MODE_DM, 4242);
  const w = openWater(g);
  const s = placeShip(g, 1, 'Quick', -1, w.x, w.y, 0);

  check('rapid fire is a real power-up type', C.PU.RAPID === 'rapid');
  check('it is in the spawn table', C.PU_WEIGHTS.some((row) => row[0] === C.PU.RAPID));
  check('base reload is the configured value', Math.abs(s.reloadTime - C.RELOAD) < 0.001, s.reloadTime);

  g.applyPowerup(s, C.PU.RAPID);
  const one = s.reloadTime;
  check('one crate shortens the reload', one < C.RELOAD, C.RELOAD + ' -> ' + one.toFixed(2));

  g.applyPowerup(s, C.PU.RAPID);
  g.applyPowerup(s, C.PU.RAPID);
  check('it stacks', s.reloadTime < one, one.toFixed(2) + ' -> ' + s.reloadTime.toFixed(2));
  for (let i = 0; i < 10; i++) g.applyPowerup(s, C.PU.RAPID);
  check('stacks are capped', s.rapidStacks === C.RAPID_MAX_STACK, s.rapidStacks);
  check('even fully stacked she still has to reload', s.reloadTime > 0.5, s.reloadTime.toFixed(2));

  // It must actually produce more broadsides in the same time.
  function broadsidesIn(seconds, stacks) {
    const gg = new Game(C.MODE_DM, 4242);
    const sh = placeShip(gg, 1, 'S', -1, w.x, w.y, 0);
    sh.rapidStacks = stacks;
    sh.reloadAt = 0;
    gg.applyInput(1, { d: 0, f: true, s: 1 });
    let n = 0;
    for (let i = 0; i < seconds * C.TICK_HZ; i++) {
      gg.update(step);
      n += gg.events.filter((e) => e.k === 'fire').length;
      gg.events.length = 0;
    }
    return n;
  }
  const slowGuns = broadsidesIn(12, 0);
  const fastGuns = broadsidesIn(12, C.RAPID_MAX_STACK);
  check('a rapid-fire ship gets more broadsides away', fastGuns > slowGuns,
    slowGuns + ' -> ' + fastGuns + ' broadsides in 12s');

  // And it is carried, so it drops when she sinks.
  const g2 = new Game(C.MODE_DM, 4242);
  const carrier = placeShip(g2, 1, 'Carrier', -1, w.x, w.y, 0);
  g2.applyPowerup(carrier, C.PU.RAPID);
  check('rapid fire is carried for the sink drop',
    carrier.powerups.indexOf(C.PU.RAPID) >= 0, JSON.stringify(carrier.powerups));
  g2.powerups.length = 0;
  g2.sink(carrier, null, 'shot');
  check('it can be dropped on sinking',
    g2.powerups.some((q) => q.type === C.PU.RAPID), g2.powerups.map((q) => q.type).join(','));

  // Respawning must clear it.
  const sp = g2.chooseSpawn(-1);
  carrier.resetForSpawn(sp.x, sp.y, 0, g2.time);
  check('respawn clears rapid fire', carrier.rapidStacks === 0 && carrier.reloadTime === C.RELOAD);
}

// =====================================================================
section('range crate');
{
  const g = new Game(C.MODE_DM, 4242);
  const w = openWater(g);
  const s = placeShip(g, 1, 'Farsight', -1, w.x, w.y, 0);

  check('range is a real power-up type', C.PU.RANGE === 'range');
  check('it is in the spawn table', C.PU_WEIGHTS.some((row) => row[0] === C.PU.RANGE));
  check('base range is the configured value', s.range === C.RANGE, s.range);

  g.applyPowerup(s, C.PU.RANGE);
  const one = s.range;
  check('one crate extends the range', one > C.RANGE, C.RANGE + ' -> ' + one.toFixed(0));

  g.applyPowerup(s, C.PU.RANGE);
  g.applyPowerup(s, C.PU.RANGE);
  check('it stacks', s.range > one, one.toFixed(0) + ' -> ' + s.range.toFixed(0));
  for (let i = 0; i < 10; i++) g.applyPowerup(s, C.PU.RANGE);
  check('stacks are capped', s.rangeStacks === C.RANGE_MAX_STACK, s.rangeStacks);

  // It must actually make the guns reach further.
  s.side = 1;
  s.reloadAt = 0;
  g.applyInput(1, { d: 0, f: true, s: 1 });
  run(g, 0.1);
  const balls = g.projectiles.slice();
  check('a shot flies further with the crate stacked',
    balls.length > 0 && balls.every((b) => b.maxDist > C.RANGE),
    balls.length ? Math.round(balls[0].maxDist) + ' vs base ' + C.RANGE : 'none');

  // And it is carried, so it drops when she sinks.
  const g2 = new Game(C.MODE_DM, 4242);
  const carrier = placeShip(g2, 1, 'Carrier', -1, w.x, w.y, 0);
  g2.applyPowerup(carrier, C.PU.RANGE);
  check('range is carried for the sink drop',
    carrier.powerups.indexOf(C.PU.RANGE) >= 0, JSON.stringify(carrier.powerups));
  g2.powerups.length = 0;
  g2.sink(carrier, null, 'shot');
  check('it can be dropped on sinking',
    g2.powerups.some((q) => q.type === C.PU.RANGE), g2.powerups.map((q) => q.type).join(','));

  // Respawning must clear it.
  const sp = g2.chooseSpawn(-1);
  carrier.resetForSpawn(sp.x, sp.y, 0, g2.time);
  check('respawn clears the range bonus', carrier.rangeStacks === 0 && carrier.range === C.RANGE);
}

// =====================================================================
section('taunts');
{
  const g = new Game(C.MODE_DM, 4242);
  const w = openWater(g);
  const s = placeShip(g, 1, 'Loudmouth', -1, w.x, w.y, 0);

  check('the insult list is not empty', C.PIRATE_INSULTS.length > 0);

  g.queueTaunt(1);
  const ev = drain(g);
  const taunt = ev.find((e) => e.k === 'taunt');
  check('a taunt event is raised', !!taunt);
  check('it names the shouting ship', taunt && taunt.v === 1);
  check('it carries one of the configured insults',
    taunt && C.PIRATE_INSULTS.indexOf(taunt.m) >= 0, taunt && taunt.m);

  g.queueTaunt(1);
  const ev2 = drain(g);
  check('a second taunt right away is throttled', !ev2.some((e) => e.k === 'taunt'));

  g.time += 2;
  g.queueTaunt(1);
  const ev3 = drain(g);
  check('a taunt is allowed again once the cooldown passes', ev3.some((e) => e.k === 'taunt'));

  g.queueTaunt(999);
  const ev4 = drain(g);
  check('a taunt for an unknown ship is ignored', !ev4.some((e) => e.k === 'taunt'));

  s.alive = false;
  g.time += 2;
  g.queueTaunt(1);
  const ev5 = drain(g);
  check('a sunk ship cannot taunt', !ev5.some((e) => e.k === 'taunt'));
}

// =====================================================================
section('sailing into land and the map edge');
{
  const g = new Game(C.MODE_DM, 4242);
  // Find a shoreline: a water tile with land nearby.
  let target = null;
  const N = C.MAP_TILES;
  for (let ty = 4; ty < N - 4 && !target; ty++) {
    for (let tx = 4; tx < N - 4; tx++) {
      if (g.tiles[ty * N + tx] >= C.TERRAIN.GRASS) {
        // approach from the west over water
        let wx = tx - 5;
        if (wx > 2 && g.tiles[ty * N + wx] === C.TERRAIN.WATER) {
          target = { x: wx * C.TILE, y: ty * C.TILE, land: tx * C.TILE };
          break;
        }
      }
    }
  }
  check('found a shoreline to test', !!target);

  g.windDir = 0; g.windStrength = 1;
  const s = placeShip(g, 1, 'Grounder', -1, target.x, target.y, 0);
  const hp0 = s.hp;
  run(g, 8);
  const ev = drain(g);
  check('ship takes damage running aground', s.hp < hp0, 'hp ' + hp0 + ' -> ' + Math.round(s.hp));
  check('grounding raises an event', ev.some((e) => e.k === 'ground'));
  check('ship stops at the shore', !g.isLand(s.x, s.y), 'terrain=' + g.terrainAt(s.x, s.y));

  // Map edge
  const g3 = new Game(C.MODE_DM, 4242);
  g3.windDir = 0; g3.windStrength = 1;
  const e1 = placeShip(g3, 1, 'Edger', -1, C.WORLD - 300, 200, 0);
  run(g3, 12);
  check('ship stops at the map edge', e1.x <= C.WORLD - C.SHIP_HALF_LEN + 0.01,
    'x=' + e1.x.toFixed(1) + ' world=' + C.WORLD);
  check('ship is not damaged by the edge', e1.hp === C.SHIP_HP, 'hp=' + e1.hp);
}

// =====================================================================
section('gunnery');
{
  const g = new Game(C.MODE_DM, 4242);
  g.windStrength = 0.4;
  const w = openWater(g);
  const shooter = placeShip(g, 1, 'Gunner', -1, w.x, w.y, 0);           // heading east
  const victim = placeShip(g, 2, 'Target', -1, w.x, w.y + 200, 0);      // 200 south
  victim.protectUntil = 0;

  shooter.side = 1;   // starboard = +y when heading east
  g.applyInput(1, { d: 0, f: true, s: 1 });
  g.applyInput(2, { d: 0, f: false, s: 1 });

  const hp0 = victim.hp;
  run(g, 2);
  const ev = drain(g);
  check('broadside fires', ev.some((e) => e.k === 'fire'));
  check('starboard broadside hits a target to starboard', victim.hp < hp0,
    'hp ' + hp0 + ' -> ' + Math.round(victim.hp));
  check('two cannons per side by default', shooter.cannons === 2, shooter.cannons);

  // Wrong side should miss entirely.
  const g2 = new Game(C.MODE_DM, 4242);
  g2.windStrength = 0.4;
  const sh2 = placeShip(g2, 1, 'Gunner', -1, w.x, w.y, 0);
  const v2 = placeShip(g2, 2, 'Target', -1, w.x, w.y + 200, 0);
  g2.applyInput(1, { d: 0, f: true, s: -1 });   // port = away from target
  run(g2, 2);
  check('port broadside misses a starboard target', v2.hp === C.SHIP_HP, 'hp=' + v2.hp);

  // No player-selectable range band; an unupgraded ship fires at the base range.
  const g3 = new Game(C.MODE_DM, 4242);
  g3.windStrength = 0.4;
  const sh3 = placeShip(g3, 1, 'Gunner', -1, w.x, w.y, 0);
  g3.applyInput(1, { d: 0, f: true, s: 1 });
  run(g3, 0.1);
  const balls = g3.projectiles.slice();
  check('every shot flies the one fixed range',
    balls.length > 0 && balls.every((b) => Math.abs(b.maxDist - C.RANGE) <= C.RANGE * 0.05),
    balls.length ? Math.round(balls[0].maxDist) + ' vs ' + C.RANGE : 'none');
  check('there is no range band list any more', C.RANGES === undefined);
  check('an unupgraded ship reports the base range', sh3.range === C.RANGE, sh3.range);

  // A range in the input must be ignored rather than honoured - only a
  // range crate can change it.
  g3.applyInput(1, { d: 0, f: true, s: 1, r: 0 });
  check('a stray range field in the input is ignored', sh3.range === C.RANGE, sh3.range);

  run(g3, 3);
  const ev3 = drain(g3);
  check('a shot that hits nothing splashes', ev3.some((e) => e.k === 'splash'));
}

// =====================================================================
section('shooting over land vs. high ground');
{
  const g = new Game(C.MODE_DM, 4242);
  const N = C.MAP_TILES;

  // Locate flat land (grass) and high ground (hill/mountain).
  let flat = null, high = null;
  for (let ty = 2; ty < N - 2; ty++) {
    for (let tx = 2; tx < N - 2; tx++) {
      const t = g.tiles[ty * N + tx];
      if (!flat && (t === C.TERRAIN.SAND || t === C.TERRAIN.GRASS)) flat = { tx, ty };
      if (!high && t >= C.TERRAIN.HILL) high = { tx, ty };
    }
  }
  check('map has flat land', !!flat);
  check('map has high ground', !!high);

  check('flat land does not block line of fire',
    g.hasLineOfFire(flat.tx * C.TILE - 200, flat.ty * C.TILE + 20, flat.tx * C.TILE + 200, flat.ty * C.TILE + 20) === true);
  check('high ground blocks line of fire',
    g.hasLineOfFire(high.tx * C.TILE - 200, high.ty * C.TILE + 20, high.tx * C.TILE + 200, high.ty * C.TILE + 20) === false);

  // A ball fired into a hill must stop there.
  const g2 = new Game(C.MODE_DM, 4242);
  g2.projectiles.push({
    id: 1, owner: 999, team: -1,
    x: high.tx * C.TILE - 150, y: high.ty * C.TILE + 20,
    vx: C.BALL_SPEED, vy: 0, travelled: 0, maxDist: 800, damage: 10, superShot: false, age: 1
  });
  run(g2, 1.2);
  const ev = drain(g2);
  check('a shot into high ground stops on the rock', ev.some((e) => e.k === 'rock'), JSON.stringify(ev.map(e => e.k)));

  // A ball fired over flat land must survive the crossing.
  const g3 = new Game(C.MODE_DM, 4242);
  g3.projectiles.push({
    id: 1, owner: 999, team: -1,
    x: flat.tx * C.TILE - 60, y: flat.ty * C.TILE + 20,
    vx: C.BALL_SPEED, vy: 0, travelled: 0, maxDist: 300, damage: 10, superShot: false, age: 1
  });
  let crossedLand = false;
  for (let i = 0; i < 0.2 * C.TICK_HZ; i++) {
    g3.update(step);
    if (g3.projectiles.length && g3.isLand(g3.projectiles[0].x, g3.projectiles[0].y)) crossedLand = true;
  }
  check('a shot flies over flat land', crossedLand, 'ball survived over land');
}

// =====================================================================
section('ramming');
{
  const g = new Game(C.MODE_DM, 4242);
  g.windStrength = 0.4;
  const w = openWater(g);

  // Bow into a beam: the rammer hurts the victim more than itself.
  const rammer = placeShip(g, 1, 'Rammer', -1, w.x, w.y, 0);
  const victim = placeShip(g, 2, 'Victim', -1, w.x + 40, w.y, Math.PI / 2);
  rammer.speed = 110;
  run(g, 0.3);
  const ev = drain(g);
  check('bow-first ramming damages the victim', victim.hp < C.SHIP_HP, 'victim hp=' + Math.round(victim.hp));
  check('the rammer takes less damage', rammer.hp > victim.hp,
    'rammer=' + Math.round(rammer.hp) + ' victim=' + Math.round(victim.hp));
  check('ram raises an event', ev.some((e) => e.k === 'ram'));

  // Bow to bow: both simply stop.
  const g2 = new Game(C.MODE_DM, 4242);
  g2.windStrength = 0.4;
  const a = placeShip(g2, 1, 'A', -1, w.x - 26, w.y, 0);
  const b = placeShip(g2, 2, 'B', -1, w.x + 26, w.y, Math.PI);
  a.speed = 100; b.speed = 100;
  run(g2, 0.3);
  const ev2 = drain(g2);
  check('bow to bow stops both ships', Math.abs(a.speed) < 1 && Math.abs(b.speed) < 1,
    'a=' + a.speed.toFixed(1) + ' b=' + b.speed.toFixed(1));
  check('bow to bow raises a head-on event', ev2.some((e) => e.k === 'headon'));
  check('head-on damage is light', a.hp >= C.SHIP_HP - C.HEADON_DAMAGE - 0.01 && a.hp < C.SHIP_HP,
    'hp=' + Math.round(a.hp));

  // Ships must never lock together. The stun and the dead stop used to be
  // re-applied on every tick the hulls overlapped, which pinned both ships
  // at zero speed against each other for good.
  function collide(name, place) {
    const gg = new Game(C.MODE_DM, 4242);
    gg.windDir = 0; gg.windStrength = 0.8;
    gg.windTargetDir = 0; gg.windTargetStrength = 0.8;
    const p1 = placeShip(gg, 1, 'A', -1, 0, 0, 0);
    const p2 = placeShip(gg, 2, 'B', -1, 0, 0, 0);
    place(p1, p2, w);
    gg.applyInput(1, { d: 0, f: false, s: 1 });
    gg.applyInput(2, { d: 0, f: false, s: 1 });

    let lockedFor = 0, worstLock = 0, overlapped = 0;
    for (let i = 0; i < 12 * C.TICK_HZ; i++) {
      gg.update(step);
      if (!p1.alive || !p2.alive) break;
      const gap = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      // "Locked" means hulls touching with neither ship able to move.
      if (gap < C.SHIP_LEN && Math.abs(p1.speed) < 3 && Math.abs(p2.speed) < 3) {
        lockedFor++; worstLock = Math.max(worstLock, lockedFor);
      } else lockedFor = 0;
      if (gap < C.SHIP_BEAM * 0.9) overlapped++;
    }
    check(name + ': never locks together', worstLock / C.TICK_HZ < 1.5,
      (worstLock / C.TICK_HZ).toFixed(1) + 's locked');
    check(name + ': hulls do not pass through each other', overlapped === 0,
      overlapped + ' overlapping ticks');
  }

  collide('bow to bow', (p1, p2, o) => {
    p1.x = o.x - 60; p1.y = o.y; p1.angle = 0; p1.speed = 100;
    p2.x = o.x + 60; p2.y = o.y; p2.angle = Math.PI; p2.speed = 100;
  });
  collide('bow into flank', (p1, p2, o) => {
    p1.x = o.x; p1.y = o.y - 60; p1.angle = Math.PI / 2; p1.speed = 110;
    p2.x = o.x; p2.y = o.y; p2.angle = 0; p2.speed = 40;
  });
  collide('side by side', (p1, p2, o) => {
    p1.x = o.x; p1.y = o.y - 18; p1.angle = 0.08; p1.speed = 90;
    p2.x = o.x; p2.y = o.y + 18; p2.angle = -0.08; p2.speed = 90;
  });
  collide('rear-ended', (p1, p2, o) => {
    p1.x = o.x - 70; p1.y = o.y; p1.angle = 0; p1.speed = 130;
    p2.x = o.x; p2.y = o.y; p2.angle = 0; p2.speed = 30;
  });
  collide('exactly co-located', (p1, p2, o) => {
    p1.x = o.x; p1.y = o.y; p1.angle = 0; p1.speed = 60;
    p2.x = o.x; p2.y = o.y; p2.angle = 0; p2.speed = 60;
  });

  // Separation has to account for which way each hull is pointing: two bows
  // meeting need far more room than two ships lying alongside.
  const gSep = new Game(C.MODE_DM, 4242);
  const n1 = placeShip(gSep, 1, 'N1', -1, w.x - 40, w.y, 0);
  const n2 = placeShip(gSep, 2, 'N2', -1, w.x + 40, w.y, Math.PI);
  run(gSep, 0.5);
  const bowGap = Math.hypot(n1.x - n2.x, n1.y - n2.y);
  const gSide = new Game(C.MODE_DM, 4242);
  const m1 = placeShip(gSide, 1, 'M1', -1, w.x, w.y - 8, 0);
  const m2 = placeShip(gSide, 2, 'M2', -1, w.x, w.y + 8, 0);
  run(gSide, 0.5);
  const sideGap = Math.hypot(m1.x - m2.x, m1.y - m2.y);
  check('bow-on ships are held further apart than ships alongside',
    bowGap > sideGap * 1.8, 'bow ' + bowGap.toFixed(0) + ' vs alongside ' + sideGap.toFixed(0));
  check('bow-on separation clears both hulls', bowGap >= C.SHIP_LEN - 1, bowGap.toFixed(0));
  check('alongside separation clears both beams', sideGap >= C.SHIP_BEAM - 1, sideGap.toFixed(0));

  // Ramming should be a nudge, not a kill: well under a full broadside.
  const broadside = C.BALL_DAMAGE * C.CANNONS_BASE;
  check('a ram hurts less than a broadside', C.RAM_DAMAGE < broadside,
    C.RAM_DAMAGE + ' vs ' + broadside);

  // Grace period: hulls grinding together must not chip anyone down.
  const g3 = new Game(C.MODE_DM, 4242);
  g3.windStrength = 0.4;
  const ram = placeShip(g3, 1, 'Rammer', -1, w.x, w.y, 0);
  const vic = placeShip(g3, 2, 'Victim', -1, w.x + 40, w.y, Math.PI / 2);
  ram.speed = 110;
  run(g3, 0.3);
  const afterFirst = vic.hp;
  check('the first ram lands', afterFirst < C.SHIP_HP, 'hp=' + Math.round(afterFirst));

  // Hold them locked together for most of the grace period.
  for (let i = 0; i < Math.floor((C.COLLIDE_COOLDOWN - 0.5) * C.TICK_HZ); i++) {
    ram.x = w.x; ram.y = w.y; ram.angle = 0; ram.speed = 110;
    vic.x = w.x + 40; vic.y = w.y; vic.angle = Math.PI / 2;
    g3.update(step);
  }
  check('no further damage during the grace period', vic.hp === afterFirst,
    Math.round(afterFirst) + ' -> ' + Math.round(vic.hp));

  // Past it, ramming works again.
  for (let i = 0; i < 1.2 * C.TICK_HZ; i++) {
    ram.x = w.x; ram.y = w.y; ram.angle = 0; ram.speed = 110;
    vic.x = w.x + 40; vic.y = w.y; vic.angle = Math.PI / 2;
    g3.update(step);
  }
  check('ramming works again after the grace period', vic.hp < afterFirst,
    Math.round(afterFirst) + ' -> ' + Math.round(vic.hp));
  check('the grace period is about ' + C.COLLIDE_COOLDOWN + 's', C.COLLIDE_COOLDOWN >= 3,
    C.COLLIDE_COOLDOWN + 's');
}

// =====================================================================
section('power-ups');
{
  const g = new Game(C.MODE_DM, 4242);
  const w = openWater(g);
  const s = placeShip(g, 1, 'Collector', -1, w.x, w.y, 0);

  s.hp = 40;
  g.applyPowerup(s, C.PU.REPAIR_S);
  check('small repair heals', s.hp === 40 + C.REPAIR_S_AMOUNT, s.hp);
  s.hp = 40;
  g.applyPowerup(s, C.PU.REPAIR_L);
  check('large repair heals more', s.hp === 40 + C.REPAIR_L_AMOUNT, s.hp);
  s.hp = 95;
  g.applyPowerup(s, C.PU.REPAIR_L);
  check('repair cannot overheal', s.hp === C.SHIP_HP, s.hp);

  g.applyPowerup(s, C.PU.CANNON);
  g.applyPowerup(s, C.PU.CANNON);
  check('extra cannons stack', s.cannons === C.CANNONS_BASE + 2, s.cannons);
  for (let i = 0; i < 20; i++) g.applyPowerup(s, C.PU.CANNON);
  check('cannons are capped', s.cannons === C.CANNONS_MAX, s.cannons);

  const base = s.sailMult;
  g.applyPowerup(s, C.PU.SAIL);
  check('larger sail increases speed multiplier', s.sailMult > base,
    base.toFixed(2) + ' -> ' + s.sailMult.toFixed(2));

  g.applyPowerup(s, C.PU.SUPER);
  check('super shot is timed', s.isSuper(g.time) && s.superUntil - g.time <= C.SUPER_TIME + 0.01,
    (s.superUntil - g.time).toFixed(1) + 's');

  // Super shot does more damage.
  const g2 = new Game(C.MODE_DM, 4242);
  const sh = placeShip(g2, 1, 'Gunner', -1, w.x, w.y, 0);
  const vic = placeShip(g2, 2, 'Target', -1, w.x, w.y + 150, 0);
  g2.applyPowerup(sh, C.PU.SUPER);
  g2.applyInput(1, { d: 0, f: true, s: 1 });
  run(g2, 1.2);
  const dmgSuper = C.SHIP_HP - vic.hp;
  const g3 = new Game(C.MODE_DM, 4242);
  const sh3 = placeShip(g3, 1, 'Gunner', -1, w.x, w.y, 0);
  const vic3 = placeShip(g3, 2, 'Target', -1, w.x, w.y + 150, 0);
  g3.applyInput(1, { d: 0, f: true, s: 1 });
  run(g3, 1.2);
  const dmgNormal = C.SHIP_HP - vic3.hp;
  check('super shot hits harder', dmgSuper > dmgNormal, dmgSuper + ' vs ' + dmgNormal);

  // Permanence: a crate waits until somebody sails over it.
  const g4 = new Game(C.MODE_DM, 4242);
  g4.powerups.push({ id: 987654, type: C.PU.SAIL, x: w.x, y: w.y, dropped: false });
  const has = () => g4.powerups.some((p) => p.id === 987654);
  run(g4, 60);
  check('power-ups never expire', has(), 'still floating after 60s');
  check('no power-up carries a lifetime', g4.powerups.every((p) => p.expires === undefined));

  // The spawner tops the map up and then holds steady.
  const g5 = new Game(C.MODE_DM, 4242);
  run(g5, 120);
  check('spawner fills the map to its cap', g5.powerups.length === C.PU_MAX,
    g5.powerups.length + ' / ' + C.PU_MAX);
  check('spawner never exceeds the cap', g5.powerups.length <= C.PU_MAX);

  // Sink drops may push past the spawn cap, but not without limit.
  const g6 = new Game(C.MODE_DM, 4242);
  for (let i = 0; i < 60; i++) {
    const victim = placeShip(g6, 500 + i, 'V' + i, -1, w.x, w.y, 0);
    g6.sink(victim, null, 'shot');
    g6.removeShip(500 + i);
  }
  check('sink drops respect the safety ceiling', g6.powerups.length <= C.PU_HARD_MAX,
    g6.powerups.length + ' <= ' + C.PU_HARD_MAX);
}

// =====================================================================
section('sinking, drops and scoring');
{
  const g = new Game(C.MODE_DM, 4242);
  const w = openWater(g);
  const killer = placeShip(g, 1, 'Killer', -1, w.x, w.y, 0);
  const victim = placeShip(g, 2, 'Victim', -1, w.x + 300, w.y, 0);
  victim.powerups = ['sail', 'cannon', 'super', 'cannon', 'sail'];

  g.sink(victim, killer, 'shot');
  check('sinking a rival scores a point', killer.score === 1, killer.score);
  check('victim is dead', !victim.alive && victim.hp === 0);
  check('drops at most 3 power-ups', g.powerups.length === C.DROP_MAX, g.powerups.length);
  check('drops land near the wreck',
    g.powerups.every((p) => Math.hypot(p.x - victim.x, p.y - victim.y) < 120));

  // A ship carrying nothing still leaves something worth collecting.
  const gEmpty = new Game(C.MODE_DM, 4242);
  const poor = placeShip(gEmpty, 1, 'Poor', -1, w.x, w.y, 0);
  poor.powerups = [];
  const before = gEmpty.powerups.length;
  gEmpty.sink(poor, null, 'shot');
  const dropped = gEmpty.powerups.length - before;
  check('a ship with no power-ups still drops one', dropped === 1, 'dropped ' + dropped);
  const types = Object.keys(C.PU).map((k) => C.PU[k]);
  check('the guaranteed drop is a real power-up type',
    types.indexOf(gEmpty.powerups[gEmpty.powerups.length - 1].type) >= 0,
    gEmpty.powerups[gEmpty.powerups.length - 1].type);

  // Over many sinks it should not always be the same crate.
  const seen = {};
  for (let i = 0; i < 120; i++) {
    const gg = new Game(C.MODE_DM, 4242);
    const v = placeShip(gg, 1, 'V', -1, w.x, w.y, 0);
    v.powerups = [];
    gg.powerups.length = 0;
    gg.sink(v, null, 'shot');
    seen[gg.powerups[0].type] = true;
  }
  check('the guaranteed drop is random', Object.keys(seen).length >= 3,
    Object.keys(seen).join(', '));

  run(g, C.RESPAWN_DELAY + 0.5);
  check('sunk ship respawns', victim.alive, 'alive=' + victim.alive);
  check('respawn restores full health', victim.hp === C.SHIP_HP, victim.hp);
  check('respawn resets cannons to base', victim.cannons === C.CANNONS_BASE, victim.cannons);
  check('respawn clears power-ups', victim.sailStacks === 0 && victim.powerups.length === 0);
  check('respawn grants brief protection', victim.protectUntil > g.time);

  // Team kill
  const gt = new Game(C.MODE_TDM, 4242);
  const mate1 = placeShip(gt, 1, 'Mate1', 0, w.x, w.y, 0);
  const mate2 = placeShip(gt, 2, 'Mate2', 0, w.x + 300, w.y, 0);
  gt.sink(mate2, mate1, 'shot');
  check('team kill costs a point', mate1.score === -1, mate1.score);
  const evt = drain(gt);
  check('team kill is flagged in the event', evt.some((e) => e.k === 'sink' && e.tk === 1));

  // Environmental death scores nothing.
  const ge = new Game(C.MODE_DM, 4242);
  const solo = placeShip(ge, 1, 'Solo', -1, w.x, w.y, 0);
  ge.sink(solo, null, 'whirlpool');
  check('drowning scores nobody a point', solo.score === 0, solo.score);
}

// =====================================================================
section('whirlpools');
{
  const g = new Game(C.MODE_DM, 4242);
  const w = openWater(g);
  // Sailing flat out directly away from the centre, from inside the rim.
  g.windDir = 0; g.windStrength = 1; g.windTargetStrength = 1; g.windTargetDir = 0;
  const s = placeShip(g, 1, 'Caught', -1, w.x + 95, w.y, 0);
  g.whirlpools.push({ id: 99, x: w.x, y: w.y, r: C.WHIRL_RADIUS, age: 0, life: 999, phase: 0 });
  const d0 = Math.hypot(s.x - w.x, s.y - w.y);
  run(g, 2);
  const d1 = Math.hypot(s.x - w.x, s.y - w.y);
  check('a ship inside the rim cannot outrun the suction', d1 < d0,
    d0.toFixed(0) + ' -> ' + d1.toFixed(0));

  // Out near the edge, a well-sailed ship should still get away.
  const gEsc = new Game(C.MODE_DM, 4242);
  gEsc.windDir = 0; gEsc.windStrength = 1; gEsc.windTargetStrength = 1; gEsc.windTargetDir = 0;
  const esc = placeShip(gEsc, 1, 'Escapee', -1, w.x + C.WHIRL_RADIUS - 15, w.y, 0);
  gEsc.whirlpools.push({ id: 99, x: w.x, y: w.y, r: C.WHIRL_RADIUS, age: 0, life: 999, phase: 0 });
  const e0 = Math.hypot(esc.x - w.x, esc.y - w.y);
  run(gEsc, 2);
  const e1 = Math.hypot(esc.x - w.x, esc.y - w.y);
  check('a ship at the outer rim can escape', e1 > e0, e0.toFixed(0) + ' -> ' + e1.toFixed(0));

  const g2 = new Game(C.MODE_DM, 4242);
  const s2 = placeShip(g2, 1, 'Doomed', -1, w.x + 10, w.y, 0);
  g2.windStrength = 1;
  g2.whirlpools.push({ id: 99, x: w.x, y: w.y, r: C.WHIRL_RADIUS, age: 0, life: 999, phase: 0 });
  run(g2, 4);
  check('the core sinks a caught ship', !s2.alive || s2.hp < 50, 'alive=' + s2.alive + ' hp=' + Math.round(s2.hp));

  const g3 = new Game(C.MODE_DM, 4242);
  g3.whirlpools.push({ id: 1, x: w.x, y: w.y, r: 200, age: 0, life: 2, phase: 0 });
  run(g3, 3);
  check('whirlpools expire', g3.whirlpools.length === 0);
}

// =====================================================================
section('spawn placement');
{
  const g = new Game(C.MODE_TDM, 4242);
  // Four on team 0 clustered in one corner, then spawn a team-0 ship.
  const base = g.spawns[10];
  for (let i = 0; i < 3; i++) {
    const s = g.addShip(i + 1, 'Blue' + i, 0, i, false);
    s.x = base.x + i * 40; s.y = base.y;
  }
  const far = g.spawns[g.spawns.length - 12];
  for (let i = 0; i < 3; i++) {
    const s = g.addShip(i + 10, 'Red' + i, 1, i, false);
    s.x = far.x + i * 40; s.y = far.y;
  }

  let nearOwn = 0;
  for (let trial = 0; trial < 40; trial++) {
    const sp = g.chooseSpawn(0);
    let dFriend = Infinity, dEnemy = Infinity;
    for (const s of g.ships.values()) {
      const d = Math.hypot(s.x - sp.x, s.y - sp.y);
      if (s.team === 0) dFriend = Math.min(dFriend, d);
      else dEnemy = Math.min(dEnemy, d);
    }
    if (dFriend < dEnemy) nearOwn++;
  }
  check('team spawns favour your own fleet', nearOwn >= 30, nearOwn + '/40 nearer to team mates');

  // Spawn points must be in open water.
  const g2 = new Game(C.MODE_DM, 4242);
  let allWater = true;
  for (let i = 0; i < 200; i++) {
    const sp = g2.chooseSpawn(-1);
    if (g2.isLand(sp.x, sp.y)) { allWater = false; break; }
  }
  check('spawns are always on open water', allWater);

  // Avoid whirlpools.
  const g3 = new Game(C.MODE_DM, 4242);
  const wp = g3.spawns[50];
  g3.whirlpools.push({ id: 1, x: wp.x, y: wp.y, r: C.WHIRL_RADIUS, age: 0, life: 999, phase: 0 });
  let clear = true;
  for (let i = 0; i < 60; i++) {
    const sp = g3.chooseSpawn(-1);
    if (Math.hypot(sp.x - wp.x, sp.y - wp.y) < C.WHIRL_RADIUS) { clear = false; break; }
  }
  check('spawns avoid whirlpools', clear);
}

// =====================================================================
section('map generation');
{
  for (const seed of [1, 12345, 99999, 555]) {
    const g = new Game(C.MODE_DM, seed);
    const N = C.MAP_TILES;
    let water = 0, land = 0, blocking = 0, edgeLand = 0;
    for (let ty = 0; ty < N; ty++) {
      for (let tx = 0; tx < N; tx++) {
        const t = g.tiles[ty * N + tx];
        if (t >= C.TERRAIN.SAND) {
          land++;
          if (t >= C.TERRAIN.HILL) blocking++;
          if (tx < 3 || ty < 3 || tx >= N - 3 || ty >= N - 3) edgeLand++;
        } else water++;
      }
    }
    const pct = (100 * land / (N * N));
    check('seed ' + seed + ': mostly water', pct < 25 && pct > 3, pct.toFixed(1) + '% land');
    check('seed ' + seed + ': has shot-blocking high ground', blocking > 10, blocking + ' tiles');
    check('seed ' + seed + ': no land at the map border', edgeLand === 0, edgeLand);
    check('seed ' + seed + ': plenty of spawn points', g.spawns.length > 200, g.spawns.length);
    check('seed ' + seed + ': has decorations', g.decor.length > 30, g.decor.length);
  }

  // Same seed must give the same map on both sides of the wire.
  const a = new Game(C.MODE_DM, 31337);
  const b = new Game(C.MODE_DM, 31337);
  let identical = true;
  for (let i = 0; i < a.tiles.length; i++) if (a.tiles[i] !== b.tiles[i]) { identical = false; break; }
  check('map generation is deterministic', identical);

  // Client-side fine sampling must agree with the server tile grid.
  const def = a.def;
  let agree = 0, total = 0;
  for (let ty = 5; ty < C.MAP_TILES - 5; ty += 7) {
    for (let tx = 5; tx < C.MAP_TILES - 5; tx += 7) {
      const h = M.heightAt(def, tx * C.TILE + C.TILE / 2, ty * C.TILE + C.TILE / 2);
      if (M.terrainFromHeight(h) === a.tiles[ty * C.MAP_TILES + tx]) agree++;
      total++;
    }
  }
  check('client height field matches server tiles', agree === total, agree + '/' + total);

  // Cannon range must not cover the map.
  check('map is bigger than cannon range', C.WORLD > C.RANGE * 3,
    'world=' + C.WORLD + ' range=' + C.RANGE +
    ' (' + (C.WORLD / C.RANGE).toFixed(1) + 'x)');
  check('a ship cannot shoot across the map', C.WORLD / C.RANGE >= 4,
    (C.WORLD / C.RANGE).toFixed(1) + 'x the gun range');
  check('the map still has room for eight ships', C.WORLD >= 2400, C.WORLD);
}

// =====================================================================
section('friendly fire');
{
  const g = new Game(C.MODE_TDM, 4242);
  const w = openWater(g);
  const a = placeShip(g, 1, 'A', 0, w.x, w.y, 0);
  const b = placeShip(g, 2, 'B', 0, w.x, w.y + 150, 0);   // same team, to starboard
  g.applyInput(1, { d: 0, f: true, s: 1 });
  run(g, 1.2);
  check('team damage is on - you can shoot your own side', b.hp < C.SHIP_HP,
    'hp=' + Math.round(b.hp));
}

console.log('\n' + (fails === 0 ? 'ALL MECHANICS CHECKS PASSED' : fails + ' CHECK(S) FAILED'));
process.exit(fails === 0 ? 0 : 1);
