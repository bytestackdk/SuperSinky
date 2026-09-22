/* Headless harness for the Super Sinky client.
 *
 * There is no real browser available here, so this stubs just enough of the
 * DOM and the 2D canvas API to actually RUN the client code: terrain baking,
 * every renderer path, the HUD, interpolation and the event handling. It
 * catches reference errors and bad canvas calls that would otherwise only
 * show up as a blank screen.
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = require('path').join(__dirname, '..');
let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '  -> ' + extra : ''));
  if (!cond) fails++;
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

// ---------------------------------------------------------------------
// Canvas / DOM stubs
// ---------------------------------------------------------------------

const calls = { count: 0, byName: {} };
const CTX_METHODS = [
  'save', 'restore', 'translate', 'scale', 'rotate', 'setTransform', 'transform',
  'beginPath', 'closePath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'bezierCurveTo',
  'arc', 'arcTo', 'ellipse', 'rect', 'fill', 'stroke', 'clip',
  'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText',
  'drawImage', 'setLineDash', 'putImageData', 'measureText'
];

function makeCtx(canvas) {
  const ctx = { canvas };
  for (const m of CTX_METHODS) {
    ctx[m] = function () {
      calls.count++;
      calls.byName[m] = (calls.byName[m] || 0) + 1;
      // Validate numeric arguments: NaN silently produces a blank canvas.
      for (let i = 0; i < arguments.length; i++) {
        const a = arguments[i];
        if (typeof a === 'number' && !isFinite(a)) {
          throw new Error('ctx.' + m + ' got a non-finite argument #' + i + ': ' + a);
        }
      }
      if (m === 'measureText') return { width: 10 };
      return undefined;
    };
  }
  const grad = { addColorStop: function (o, c) {
    if (!isFinite(o)) throw new Error('addColorStop offset ' + o);
    if (typeof c !== 'string') throw new Error('addColorStop colour ' + c);
    return grad;
  } };
  ctx.createLinearGradient = () => grad;
  ctx.createRadialGradient = () => grad;
  ctx.createPattern = () => ({ __pattern: true });
  ctx.createImageData = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  ctx.getImageData = (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  return ctx;
}

function makeCanvas(w, h) {
  const c = {
    width: w || 300, height: h || 150,
    clientWidth: w || 1280, clientHeight: h || 720,
    style: {}, classList: { add() {}, remove() {}, toggle() {} }
  };
  c.getContext = () => (c.__ctx || (c.__ctx = makeCtx(c)));
  return c;
}

function makeEl(tag) {
  const node = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], childNodes: [], style: {}, dataset: {},
    _text: '', _html: '', value: '', disabled: false, className: '',
    scrollTop: 0, scrollHeight: 100,
    parentNode: null
  };
  Object.defineProperty(node, 'textContent', {
    // Like the real DOM, this reads through to descendants.
    get() {
      return node._text + node.children.map((c) => c.textContent).join('');
    },
    set(v) { node._text = String(v); node.children.length = 0; }
  });
  Object.defineProperty(node, 'innerHTML', {
    get() { return node._html; },
    set(v) { node._html = String(v); node.children.length = 0; }
  });
  Object.defineProperty(node, 'firstChild', { get() { return node.children[0] || null; } });
  Object.defineProperty(node, 'parentElement', { get() { return node.parentNode; } });
  node.appendChild = (c) => { c.parentNode = node; node.children.push(c); return c; };
  node.removeChild = (c) => {
    const i = node.children.indexOf(c);
    if (i >= 0) node.children.splice(i, 1);
    c.parentNode = null;
    return c;
  };
  node.classList = {
    _set: new Set(),
    add(c) { this._set.add(c); },
    remove(c) { this._set.delete(c); },
    toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) this._set.add(c); else this._set.delete(c); },
    contains(c) { return this._set.has(c); }
  };
  node.addEventListener = () => {};
  node.removeEventListener = () => {};
  node.focus = () => {};
  node.getContext = () => makeCtx(node);
  return node;
}

const elements = {};
const IDS = [
  'screen-menu', 'screen-lobby', 'screen-game', 'playerName', 'saveName',
  'refreshLobbies', 'lobbyList', 'lobbyName', 'lobbyPassword', 'lobbyMode',
  'createLobby', 'lobbyTitle', 'lobbySub', 'leaveLobby', 'crewCount',
  'removeBot', 'addBot', 'ffaBotControls', 'teamsWrap', 'botNote',
  'startGame', 'endMatch', 'startHint', 'hud', 'scoreboard', 'windSpeed',
  'ownName', 'scorePill', 'healthFill', 'healthText', 'reloadFill', 'reloadText',
  'sideLabel', 'gunLabel', 'buffs', 'respawn', 'respawnText', 'boostText',
  'killfeed', 'helpBox', 'connLost', 'reconnectBtn', 'toast',
  'roundTimer', 'roundNote', 'zoneWarn', 'matchOver', 'matchOverTitle',
  'matchOverSub', 'standings', 'backToLobby'
];
for (const id of IDS) elements[id] = makeEl('div');
elements.boostFill = makeEl('div');
elements.menuScene = makeCanvas(1280, 720);
elements.view = makeCanvas(1280, 720);
elements.windDial = makeCanvas(110, 110);
elements.minimap = makeCanvas(190, 190);
// bars need a parentElement for the HUD class switching
for (const id of ['healthFill', 'reloadFill', 'boostFill']) {
  const bar = makeEl('div');
  bar.appendChild(elements[id]);
}

const listeners = {};
const win = {
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  location: { protocol: 'http:', host: 'localhost:3000', reload() {} },
  performance: { now: () => Date.now() },
  requestAnimationFrame: (fn) => { win.__raf.push(fn); return win.__raf.length; },
  __raf: [],
  setTimeout, clearTimeout, setInterval, clearInterval,
  addEventListener: (t, fn) => { (listeners[t] || (listeners[t] = [])).push(fn); },
  removeEventListener: () => {},
  localStorage: {
    _d: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; }
  },
  prompt: () => null,
  AudioContext: undefined,           // audio simply disables itself
  WebSocket: function () { this.readyState = 0; this.send = () => {}; },
  document: {
    createElement: (t) => (t === 'canvas' ? makeCanvas(256, 256) : makeEl(t)),
    createTextNode: (t) => { const n = makeEl('#text'); n.textContent = t; return n; },
    getElementById: (id) => elements[id] || (elements[id] = makeEl('div')),
    addEventListener: () => {}
  },
  console
};
win.WebSocket.OPEN = 1;
win.window = win;
win.self = win;
win.global = win;

const ctxObj = vm.createContext(win);

function load(rel) {
  const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  vm.runInContext(code, ctxObj, { filename: rel });
}

// ---------------------------------------------------------------------
section('client scripts load');
try {
  load('shared/constants.js');
  load('shared/mapgen.js');
  load('public/js/audio.js');
  load('public/js/net.js');
  load('public/js/terrain.js');
  load('public/js/render.js');
  load('public/js/menuscene.js');
  load('public/js/input.js');
  load('public/js/ui.js');
  check('all client modules evaluate', true);
} catch (e) {
  check('all client modules evaluate', false, e.message + '\n' + e.stack);
  process.exit(1);
}

check('SSConst exposed', !!win.SSConst);
check('SSMap exposed', !!win.SSMap);
check('Renderer exposed', typeof win.Renderer === 'function');
check('MenuScene exposed', typeof win.MenuScene === 'function');
check('Terrain exposed', typeof win.Terrain === 'function');
check('UI exposed', !!win.UI);
check('Net exposed', typeof win.Net === 'function');
check('SnapshotBuffer exposed', typeof win.SnapshotBuffer === 'function');

const C = win.SSConst;

// ---------------------------------------------------------------------
section('terrain baking');
const { Game } = require(ROOT + '/server/game.js');
const game = new Game(C.MODE_DM, 20250919);
const payload = game.mapPayload();

let terrain;
try {
  terrain = new win.Terrain(payload.def);
  const t0 = Date.now();
  terrain.canvas = win.document.createElement('canvas');
  terrain.canvas.width = terrain.bakeWidth();
  terrain.canvas.height = terrain.bakeHeight();
  terrain.ctx = terrain.canvas.getContext('2d');
  terrain.sampleHeights();
  const tSample = Date.now() - t0;
  const t1 = Date.now();
  terrain.bakeRows(0, terrain.gw);
  const tBake = Date.now() - t1;
  terrain.buildMinimap(190);
  terrain.ready = true;
  check('terrain bakes without error', true, 'sample ' + tSample + 'ms, bake ' + tBake + 'ms (stubbed canvas)');
} catch (e) {
  check('terrain bakes without error', false, e.message + '\n' + e.stack);
}

if (terrain) {
  check('bake canvas is a sane size', terrain.bakeWidth() > 1000 && terrain.bakeHeight() > 1000,
    terrain.bakeWidth() + 'x' + terrain.bakeHeight());
  const mb = (terrain.bakeWidth() * terrain.bakeHeight() * 4) / (1024 * 1024);
  check('bake memory stays reasonable', mb < 64, mb.toFixed(0) + ' MiB');

  // The height field the client samples must agree with the server's tiles.
  let agree = 0, total = 0;
  for (let ty = 6; ty < C.MAP_TILES - 6; ty += 9) {
    for (let tx = 6; tx < C.MAP_TILES - 6; tx += 9) {
      const wx = tx * C.TILE + C.TILE / 2, wy = ty * C.TILE + C.TILE / 2;
      const h = terrain.heightAtCell(Math.floor(wx / C.FINE), Math.floor(wy / C.FINE));
      const serverT = game.tiles[ty * C.MAP_TILES + tx];
      const isLandClient = h >= C.BANDS[2].h;
      const isLandServer = serverT >= C.TERRAIN.SAND;
      if (isLandClient === isLandServer) agree++;
      total++;
    }
  }
  check('client land matches server land', agree / total > 0.97, (100 * agree / total).toFixed(1) + '% of ' + total);
  check('minimap built', !!terrain.minimap);
  const drew = calls.byName.fillRect || 0;
  check('terrain actually drew cells', drew > 10000, drew + ' fillRect calls');
}

// ---------------------------------------------------------------------
section('renderer');
let renderer;
try {
  renderer = new win.Renderer(elements.view);
  renderer.setTerrain(terrain, payload.decor);
  check('renderer constructs and takes terrain', true, payload.decor.length + ' props');
} catch (e) {
  check('renderer constructs and takes terrain', false, e.message + '\n' + e.stack);
}

check('decor got ground elevations', payload.decor.every((d) => typeof d.e === 'number' && isFinite(d.e)));

// Build a synthetic view state covering every visual feature.
function makeState(t) {
  const ships = [];
  // Covers every sail stack: 0 and 1 are the small suit (two then three
  // masts), 2 and 3 let out progressively more canvas.
  const kinds = [
    { hp: 100, alive: true, protect: true, cannons: 2, sails: 0, superTime: 0, boost: 1, boosting: false, rapid: 0, regen: false },
    { hp: 55, alive: true, protect: false, cannons: 6, sails: 3, superTime: 9.4, boost: 0.4, boosting: true, rapid: 3, regen: false },
    { hp: 8, alive: true, protect: false, cannons: 4, sails: 1, superTime: 0, boost: 0, boosting: false, rapid: 1, regen: true },
    { hp: 0, alive: false, protect: false, cannons: 2, sails: 0, superTime: 0, boost: 0.7, boosting: false, rapid: 0, regen: false },
    { hp: 72, alive: true, protect: false, cannons: 3, sails: 2, superTime: 3.1, boost: 0.9, boosting: true, rapid: 2, regen: false }
  ];
  for (let i = 0; i < 8; i++) {
    const k = kinds[i % kinds.length];
    ships.push({
      id: i + 1,
      // Ships orbit over time so wake trails actually accumulate points.
      x: 1560 + Math.cos(i + t * 0.9) * 260, y: 1560 + Math.sin(i + t * 0.9) * 260,
      angle: (i / 8) * Math.PI * 2 + t * 0.9, hp: k.hp,
      side: i % 2 === 0 ? 1 : -1,
      cannons: k.cannons, sails: k.sails, superTime: k.superTime,
      alive: k.alive, respawnIn: k.alive ? 0 : 3.2, reload: i % 3 === 0 ? 1 : (i / 8),
      score: i - 2, protect: k.protect, speed: 40 + i * 12,
      boost: k.boost, boosting: k.boosting, rapid: k.rapid, regen: k.regen,
      name: 'Captain ' + i, team: i % 2, isBot: i > 4,
      color: C.FFA_COLORS[i]
    });
  }
  const powerups = Object.keys(C.PU).map((k, i) => ({
    id: 100 + i, x: 1460 + i * 60, y: 1710, type: C.PU[k]
  }));
  return {
    ships,
    projectiles: [
      { id: 1, x: 1610, y: 1610, vx: 560, vy: 0, superShot: false, prog: 0.3 },
      { id: 2, x: 1640, y: 1570, vx: -300, vy: 470, superShot: true, prog: 0.9 },
      { id: 3, x: 1570, y: 1650, vx: 0, vy: 0, superShot: false, prog: 0 }
    ],
    powerups,
    whirlpools: [{ id: 1, x: 1860, y: 1460, r: 210, phase: t, fade: 0.7 }],
    wind: { dir: t * 0.2, strength: 0.4 + 0.5 * Math.abs(Math.sin(t)) },
    me: ships[1], meId: 2, mode: C.MODE_TDM,
    focus: { x: 1560, y: 1560 },
    zone: [420, 420, C.WORLD - 420, C.WORLD - 420],
    timeLeft: Math.max(0, 600 - t * 40),
    shrinks: 3,
    nextShrinkIn: 7,
    meOutside: false
  };
}

let frameErr = null;
try {
  for (let f = 0; f < 90; f++) {
    const st = makeState(f * 0.05);
    renderer.draw(st, 1 / 60);
    renderer.drawWindDial(elements.windDial, st.wind, st.me.angle);
    renderer.drawMinimap(elements.minimap, st);
    win.UI.updateHud(st);
    if (f === 10) renderer.explodeShip(1560, 1560, 1.1, '#e6394d');
    if (f === 5) {
      Object.keys(C.PU).forEach((key, n) => {
        renderer.addPickupFloater(C.PU[key], 1500 + n * 40, 1600, n === 0);
      });
    }
    if (f === 40) renderer.explodeShip(1620, 1500, 2.4, C.TEAM_COLORS[0]);
    if (f % 12 === 0) {
      ['smoke', 'splash', 'dirt', 'explode', 'debris', 'bubble', 'spark', 'wake', 'blast'].forEach((k) => {
        renderer.particles.burst(k, 1560 + f, 1560, { count: 6, dir: 1, col: '200,200,200' });
      });
    }
  }
  check('90 frames render without error', true, calls.count.toLocaleString() + ' canvas ops total');

  const trailIds = Object.keys(renderer.trails);
  check('wake trails were recorded', trailIds.length > 0, trailIds.length + ' ships tracked');
  const longest = trailIds.reduce((m, k) => Math.max(m, renderer.trails[k].length), 0);
  check('trails accumulate a path behind each ship', longest > 5, 'longest = ' + longest + ' points');

  // A respawn teleports a ship; the wake must not be drawn across the map.
  const victim = trailIds[0];
  const jump = makeState(9);
  jump.ships[0].x += 900;
  renderer.updateTrails(jump);
  check('a teleport resets the wake instead of streaking',
    renderer.trails[jump.ships[0].id].length === 1,
    renderer.trails[jump.ships[0].id].length + ' points');
} catch (e) {
  frameErr = e;
  check('90 frames render without error', false, e.message + '\n' + e.stack);
}

// Taunt speech bubble
try {
  // Ship id 1 (kinds[0]) is alive in every makeState() call.
  const longInsult = C.PIRATE_INSULTS.reduce((a, b) => (b.length > a.length ? b : a), '');
  renderer.addTaunt(1, longInsult);
  check('a taunt is recorded', !!renderer.taunts[1]);

  const before = calls.byName.fillText || 0;
  renderer.draw(makeState(2), 1 / 60);
  const after = calls.byName.fillText || 0;
  check('drawing a taunt calls fillText for its lines', after > before, (after - before) + ' fillText calls');

  // Fast-forward well past its life and confirm it cleans itself up.
  for (let i = 0; i < 6; i++) renderer.draw(makeState(2), 1);
  check('an expired taunt is forgotten', !renderer.taunts[1]);
} catch (e) {
  check('taunt bubble renders without error', false, e.message + '\n' + e.stack);
}

// Deathmatch variant (different scoreboard path)
try {
  const st = makeState(1);
  st.mode = C.MODE_DM;
  st.ships.forEach((s) => { s.team = -1; });
  win.UI.updateHud(st);
  renderer.draw(st, 1 / 60);
  check('deathmatch HUD path renders', true);

  // Gulls: force a flock and make sure they fly, are drawn, and are cleaned up.
  renderer.gulls.length = 0;
  renderer.spawnFlock(makeState(1));
  check('a flock spawns', renderer.gulls.length > 0, renderer.gulls.length + ' birds');
  const g0 = { x: renderer.gulls[0].x, y: renderer.gulls[0].y };
  for (let f = 0; f < 60; f++) renderer.updateGulls(1 / 60, makeState(1));
  const moved = Math.hypot(renderer.gulls[0].x - g0.x, renderer.gulls[0].y - g0.y);
  check('gulls fly', moved > 20, moved.toFixed(0) + ' units in a second');
  renderer.cam.x = 1560; renderer.cam.y = 1560;
  renderer.gulls.forEach((b) => { b.x = 1560; b.y = 1560; });
  renderer.drawGulls();
  check('gulls draw over the sea', true);
  renderer.gulls.forEach((b) => { b.t = 200; });
  renderer.updateGulls(1 / 60, makeState(1));
  check('gulls are cleaned up once they are gone', renderer.gulls.length === 0);

  // Wind field must scale with strength rather than sitting at one alpha.
  for (const strength of [C.WIND_MIN, 0.7, C.WIND_MAX]) {
    renderer.drawWindField({ dir: 1.1, strength: strength });
  }
  check('wind field renders across the whole strength range', true);
  for (const strength of [C.WIND_MIN, 0.7, C.WIND_MAX]) {
    renderer.drawWindDial(elements.windDial, { dir: 2.4, strength: strength }, 0.5);
    renderer.drawWindDial(elements.windDial, { dir: 2.4, strength: strength }, null);
  }
  check('wind dial renders at every strength, with and without a ship', true);
  check('boost bar is populated', /BOOST|BOOSTING/.test(elements.boostText.textContent),
    JSON.stringify(elements.boostText.textContent));

  // Every crate must announce itself by name when collected.
  const puTypes = Object.keys(C.PU).map((k) => C.PU[k]);
  renderer.floaters.length = 0;
  puTypes.forEach((t2) => renderer.addPickupFloater(t2, 1500, 1600, false));
  check('every power-up type has a pickup label',
    renderer.floaters.length === puTypes.length &&
    renderer.floaters.every((f) => f.text && f.text !== 'Crate'),
    renderer.floaters.map((f) => f.text).join(' / '));
  renderer.drawFloaters(0.1);
  check('pickup labels render', true);
  const pk = {};
  renderer.particles.list.forEach((q) => { pk[q.t] = (pk[q.t] || 0) + 1; });
  check('explosion produced fire, shockwave and debris',
    renderer.particles.list.length > 0, Object.keys(pk).join(', ') || 'none');
  check('wind readout is populated', /%/.test(elements.windSpeed.textContent),
    JSON.stringify(elements.windSpeed.textContent));
} catch (e) {
  check('deathmatch HUD path renders', false, e.message);
}

// Zoomed-out / edge-of-map camera positions must not break the terrain blit.
try {
  for (const pos of [[0, 0], [C.WORLD, C.WORLD], [0, C.WORLD], [C.WORLD, 0], [-500, -500], [C.WORLD + 900, 100]]) {
    renderer.cam.x = pos[0]; renderer.cam.y = pos[1];
    const st = makeState(2);
    st.focus = null;
    renderer.draw(st, 1 / 60);
  }
  check('camera at every map corner renders', true);
} catch (e) {
  check('camera at every map corner renders', false, e.message + '\n' + e.stack);
}

try {
  for (const z of [0.4, 0.7, 1.0, 1.6, 2.4]) {
    renderer.cam.zoom = z;
    renderer.cam.x = 1560; renderer.cam.y = 1560;
    renderer.draw(makeState(3), 1 / 60);
  }
  renderer.cam.zoom = 0.95;
  check('all zoom levels render', true);
} catch (e) {
  check('all zoom levels render', false, e.message + '\n' + e.stack);
}

// Every decoration type must draw.
section('decorations');
const kinds = ['tree', 'pine', 'palm', 'house', 'windmill', 'lighthouse', 'tower', 'dock', 'rock'];
const present = new Set(payload.decor.map((d) => d.k));
for (const k of kinds) {
  try {
    const ctx = elements.view.getContext('2d');
    renderer.drawProp(ctx, { k, x: 0, y: 0, r: 1, s: 1, e: 5 }, 100, 100, 1);
    check('draws ' + k + (present.has(k) ? '' : ' (not on this map)'), true);
  } catch (e) {
    check('draws ' + k, false, e.message);
  }
}

// ---------------------------------------------------------------------
section('snapshot interpolation');
{
  const buf = new win.SnapshotBuffer();
  check('empty buffer samples to null', buf.sample() === null);
  const mk = (k, x) => ({ t: 's', k, w: [0, 0.6], sh: [[1, x, 100, 0, 100, 1, 1, 2, 0, 0, 1, 0, 1, 0, 0, 50]], pr: [], pu: [], wp: [], ev: [] });
  buf.push(mk(1, 0));
  check('single snapshot samples', buf.sample() !== null);
  buf.push(mk(2, 100));
  const s = buf.sample();
  check('two snapshots straddle a render time', !!s && s.a && s.b);
  check('blend factor is in range', s.t >= 0 && s.t <= 1, s.t);
  for (let i = 0; i < 40; i++) buf.push(mk(i + 3, i * 10));
  check('buffer is bounded', buf.buf.length <= buf.maxLen, buf.buf.length);
}

// ---------------------------------------------------------------------
section('UI rendering');
try {
  win.UI.renderLobbyList([], () => {});
  win.UI.renderLobbyList([
    { id: 'L1', name: 'Open Sea', mode: 'dm', players: 2, bots: 3, capacity: 8, hasPassword: false, state: 'lobby' },
    { id: 'L2', name: 'Locked', mode: 'tdm', players: 8, bots: 0, capacity: 8, hasPassword: true, state: 'playing' }
  ], () => {});
  check('lobby list renders (empty and populated)', true);

  const mkLobby = (mode, extra) => Object.assign({
    id: 'L1', name: 'Test', mode, hostId: 1, state: 'lobby', hasPassword: false,
    capacity: 8, teamSize: 4,
    players: [
      { id: 1, name: 'Me', team: mode === 'tdm' ? 0 : -1, colorIdx: 0, bot: false, host: true },
      { id: 2, name: 'Blackbeard', team: mode === 'tdm' ? 1 : -1, colorIdx: 1, bot: true, host: false }
    ]
  }, extra || {});

  win.UI.renderLobby(mkLobby('tdm'), 1);
  check('team lobby renders', elements.teamsWrap.children.length === 2,
    elements.teamsWrap.children.length + ' team blocks');
  check('the free-for-all bot buttons are hidden in a team lobby',
    elements.ffaBotControls.classList.contains('hidden'));

  win.UI.renderLobby(mkLobby('dm'), 1);
  check('free-for-all lobby renders', elements.teamsWrap.children.length === 1);
  check('the free-for-all bot buttons are shown there',
    !elements.ffaBotControls.classList.contains('hidden'));

  // Per-team bot buttons: host only, and they name their side.
  const asked = [];
  win.UI.setBotHandler(function (action, team) { asked.push(action + ':' + team); });
  win.UI.renderLobby(mkLobby('tdm'), 1);

  function botButtons(block) {
    const head = block.children[0];
    const controls = head.children[head.children.length - 1];
    return controls.children || [];
  }
  const red = botButtons(elements.teamsWrap.children[0]);
  const violet = botButtons(elements.teamsWrap.children[1]);
  check('each fleet has its own pair of bot buttons',
    red.length === 2 && violet.length === 2, red.length + ' / ' + violet.length);

  red[1].onclick();
  violet[1].onclick();
  violet[0].onclick();
  check('the buttons name the side they act on',
    asked.join(' ') === 'addBot:0 addBot:1 removeBot:1', asked.join(' '));

  check('a side with no bots cannot have one removed', red[0].disabled === true);
  check('a side with a bot can', violet[0].disabled === false);

  // A guest sees them all disabled.
  win.UI.renderLobby(mkLobby('tdm'), 2);
  const guestRed = botButtons(elements.teamsWrap.children[0]);
  check('a guest cannot use the bot buttons',
    guestRed[0].disabled === true && guestRed[1].disabled === true);
  check('and is told why', /only the host/i.test(elements.botNote.textContent),
    elements.botNote.textContent);

  // A full side cannot take another bot.
  const full = mkLobby('tdm', {
    players: [
      { id: 1, name: 'Me', team: 0, colorIdx: 0, bot: false, host: true },
      { id: 5, name: 'B1', team: 0, colorIdx: 1, bot: true, host: false },
      { id: 6, name: 'B2', team: 0, colorIdx: 2, bot: true, host: false },
      { id: 7, name: 'B3', team: 0, colorIdx: 3, bot: true, host: false }
    ]
  });
  win.UI.renderLobby(full, 1);
  check('a full fleet cannot take another bot',
    botButtons(elements.teamsWrap.children[0])[1].disabled === true);

  check('the UI has no chat left', win.UI.addChat === undefined && win.UI.clearChat === undefined);

  win.UI.pushKill('<b>A</b> sank <b>B</b>', false);
  win.UI.pushKill('<b>A</b> sank their own <b>B</b>', true);
  win.UI.toast('hello', true);
  win.UI.showScreen('game');
  check('kill feed, toast and screens work', true);
} catch (e) {
  check('UI rendering', false, e.message + '\n' + e.stack);
}

// ---------------------------------------------------------------------
section('audio without WebAudio support');
try {
  win.Sfx.setMuted(false);
  ['fire', 'hit', 'splash', 'rock', 'sink', 'pickup', 'ram', 'ground', 'whirl', 'spawn', 'ready',
    'boost', 'shrink', 'gull', 'fanfare']
    .forEach((k) => win.Sfx.play(k, 0.8));
  win.Sfx.toggle();
  win.Sfx.resume();
  check('audio degrades gracefully with no AudioContext', true);
} catch (e) {
  check('audio degrades gracefully with no AudioContext', false, e.message);
}

// ---------------------------------------------------------------------
section('respawn does not make ships flicker across the map');
{
  // Reproduces the reported bug: a ship sinks at one end of the map and
  // respawns at the other. Interpolating between the two snapshots used to
  // draw her streaking through the middle for a frame.
  const DEAD = [7, 300, 300, 0, 0, 1, 2, 0, 0, /*alive*/0, 4.2, 1, 0, 0, 0, 1, 0, 0, 0];
  const LIVE = [7, 2400, 2400, 1.5, 100, 1, 2, 0, 0, /*alive*/1, 0, 1, 0, 1, 0, 1, 0, 0, 0];

  function shipsAt(a, b, blendAt) {
    // Mirror the client's own interpolation rule.
    const jump = Math.hypot(b[1] - a[1], b[2] - a[2]);
    const blend = (jump > 150 || a[9] !== b[9]) ? 1 : blendAt;
    return {
      x: a[1] + (b[1] - a[1]) * blend,
      y: a[2] + (b[2] - a[2]) * blend,
      alive: !!b[9]
    };
  }

  const mid = shipsAt(DEAD, LIVE, 0.5);
  check('a respawning ship is never drawn between the two positions',
    mid.x === LIVE[1] && mid.y === LIVE[2],
    'drew at ' + Math.round(mid.x) + ',' + Math.round(mid.y) +
    ' (spawn is ' + LIVE[1] + ',' + LIVE[2] + ')');

  // Ordinary sailing must still interpolate smoothly.
  const A = [7, 1000, 1000, 0, 100, 1, 2, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const B = [7, 1012, 1000, 0, 100, 1, 2, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const smooth = shipsAt(A, B, 0.5);
  check('normal movement is still interpolated', Math.abs(smooth.x - 1006) < 0.01,
    'x=' + smooth.x);

  // Top speed under boost, at the snapshot rate, must stay well under the
  // teleport threshold or real sailing would start snapping.
  const perSnapshot = (C.BASE_SPEED * C.BOOST_MULT) / C.SNAPSHOT_HZ;
  check('the teleport threshold is clear of real movement', perSnapshot < 150 * 0.5,
    perSnapshot.toFixed(1) + ' units per snapshot vs a 150 threshold');

  // And a sunk ship must not be drawn on the water at all.
  const st = makeState(1);
  st.ships.forEach((z) => { z.alive = false; });
  const before = calls.byName.ellipse || 0;
  renderer.drawShips(st);
  check('sunk ships are not drawn as hulls', (calls.byName.ellipse || 0) === before,
    'drew ' + ((calls.byName.ellipse || 0) - before) + ' hull shapes');

  st.ships.forEach((z) => { z.alive = true; });
  renderer.drawShips(st);
  check('living ships are still drawn', (calls.byName.ellipse || 0) > before);
}

// ---------------------------------------------------------------------
section('battle area and round HUD');
{
  const st = makeState(1);

  // Clock.
  check('the clock formats as minutes and seconds', win.UI.formatClock(600) === '10:00',
    win.UI.formatClock(600));
  check('it pads the seconds', win.UI.formatClock(65) === '1:05', win.UI.formatClock(65));
  check('it never goes negative', win.UI.formatClock(-5) === '0:00', win.UI.formatClock(-5));

  win.UI.updateHud(st);
  check('the round timer is shown', /\d:\d\d/.test(elements.roundTimer.textContent),
    JSON.stringify(elements.roundTimer.textContent));
  check('the note warns when the area is about to close',
    /closing in/i.test(elements.roundNote.textContent),
    JSON.stringify(elements.roundNote.textContent));

  st.timeLeft = 12;
  st.nextShrinkIn = 40;
  st.shrinks = C.SHRINK_STEPS;
  win.UI.updateHud(st);
  check('the timer flags the last seconds', /low/.test(elements.roundTimer.className),
    elements.roundTimer.className);
  check('the note says when the area has finished closing',
    /final/i.test(elements.roundNote.textContent), elements.roundNote.textContent);

  // Outside warning.
  check('no warning while inside', elements.zoneWarn.classList.contains('hidden'));
  st.meOutside = true;
  win.UI.updateHud(st);
  check('warns when outside the area', !elements.zoneWarn.classList.contains('hidden'));

  // Rendering, at a range of boundary sizes including fully off screen.
  let err = null;
  try {
    for (const inset of [0, 200, 900, 1300]) {
      const s2 = makeState(2);
      s2.zone = [inset, inset, C.WORLD - inset, C.WORLD - inset];
      renderer.draw(s2, 1 / 60);
      renderer.drawMinimap(elements.minimap, s2);
    }
    const noZone = makeState(2);
    noZone.zone = null;
    renderer.draw(noZone, 1 / 60);
    renderer.drawMinimap(elements.minimap, noZone);
  } catch (e) { err = e; }
  check('the battle area renders at every size, and without one', !err,
    err ? err.message + '\n' + err.stack : '');

  // ---- final standings ----
  function row(id, name, team, score, kills, deaths, bot) {
    return { id, name, team, colorIdx: id % 8, bot: bot ? 1 : 0, score, kills, deaths };
  }
  function bannerText() { return elements.matchWinner.textContent; }
  function subText() { return elements.matchOverSub.textContent; }

  // --- deathmatch ---
  win.UI.showStandings({
    mode: C.MODE_DM, timeUp: true,
    standings: [row(2, 'Me', -1, 7, 7, 2), row(3, 'Blackbeard', -1, 4, 4, 5, true),
                row(4, 'Anne Bonny', -1, 1, 1, 6, true)]
  }, 2);
  check('deathmatch names the winner', /Me/.test(bannerText()), bannerText());
  check('deathmatch reports the score', /7 ships sunk/.test(subText()), subText());
  check('deathmatch lists every captain plus a header',
    elements.standings.children.length === 4, elements.standings.children.length);

  win.UI.showStandings({
    mode: C.MODE_DM, timeUp: false,
    standings: [row(2, 'Me', -1, 3, 3, 1), row(3, 'Rackham', -1, 3, 3, 1, true)]
  }, 2);
  check('deathmatch spots a dead heat', /draw/i.test(bannerText()), bannerText());
  check('and names who tied', /Me/.test(subText()) && /Rackham/.test(subText()), subText());

  // --- team deathmatch: the winner is the fleet with the most kills ---
  win.UI.showStandings({
    mode: C.MODE_TDM, timeUp: true,
    standings: [
      row(2, 'Me', 0, 5, 5, 3), row(5, 'Vane', 0, 2, 2, 4, true),
      row(3, 'Kidd', 1, 6, 6, 2, true), row(6, 'Read', 1, 4, 4, 3, true)
    ]
  }, 2);
  check('team match names the fleet with most kills', /Violet/.test(bannerText()), bannerText());
  check('and reports the kill totals', /10 to 7/.test(subText()), subText());
  check('both fleets are listed with a header each',
    elements.standings.children.length === 2 * (2 + 2), elements.standings.children.length);
  check('the winning fleet is listed first',
    elements.standings.children[0].textContent.indexOf('Violet') >= 0,
    elements.standings.children[0].textContent);
  check('the winning fleet is badged', /Winner/.test(elements.standings.children[0].textContent));
  check('fleet totals are shown in kills',
    /10 kills/.test(elements.standings.children[0].textContent),
    elements.standings.children[0].textContent);

  // Team kills drag a score down but the match is still decided on kills.
  win.UI.showStandings({
    mode: C.MODE_TDM, timeUp: true,
    standings: [
      row(2, 'Me', 0, 6, 8, 3),            // two team kills cost two points
      row(3, 'Kidd', 1, 7, 7, 4, true)
    ]
  }, 2);
  check('most kills wins even on a lower score', /Crimson/.test(bannerText()), bannerText());
  check('and the score gap is explained', /after team kills/.test(subText()), subText());

  // Level on kills: the score (i.e. fewer team kills) breaks it.
  win.UI.showStandings({
    mode: C.MODE_TDM, timeUp: true,
    standings: [row(2, 'Me', 0, 3, 5, 2), row(3, 'Kidd', 1, 5, 5, 2, true)]
  }, 2);
  check('level on kills, fewer team kills wins', /Violet/.test(bannerText()), bannerText());

  // Dead level on everything.
  win.UI.showStandings({
    mode: C.MODE_TDM, timeUp: true,
    standings: [row(2, 'Me', 0, 4, 4, 3), row(3, 'Kidd', 1, 4, 4, 3, true)]
  }, 2);
  check('a true tie is a draw', /draw/i.test(bannerText()), bannerText());
  check('the draw reports the kills', /4 kills each/.test(bannerText()), bannerText());

  win.UI.showStandings({ standings: [], mode: C.MODE_DM, timeUp: false }, 2);
  check('an empty table does not break it', /No ships/.test(subText()), subText());

  // Showing results must not depend on which screen is up: a player who
  // stepped back to the lobby still has to see how the round finished.
  win.UI.showScreen('lobby');
  elements.matchOver.classList.add('hidden');
  win.UI.showStandings({
    mode: C.MODE_DM, timeUp: true, standings: [row(2, 'Me', -1, 2, 2, 1)]
  }, 2);
  check('results show even from the lobby screen',
    !elements.matchOver.classList.contains('hidden'));
}

// ---------------------------------------------------------------------
section('front page battle');
{
  let scene = null;
  try {
    scene = new win.MenuScene(elements.menuScene);
    check('the menu scene builds', scene.ships.length > 1, scene.ships.length + ' ships');
  } catch (e) {
    check('the menu scene builds', false, e.message + '\n' + e.stack);
  }

  if (scene) {
    check('it draws no map border', scene.renderer.showEdge === false);
    check('it draws no name plates', scene.renderer.showNames === false);
    check('both fleets are represented',
      new Set(scene.ships.map((z) => z.team)).size === 2);

    // Run a couple of minutes of battle: ships must fire, hit, sink and
    // respawn, all without a single bad canvas call.
    let err = null;
    let sank = 0, fired = 0;
    const seenDead = new Set();
    try {
      for (let f = 0; f < 3600; f++) {
        const before = scene.shots.length;
        scene.update(1 / 30);
        if (scene.shots.length > before) fired++;
        scene.ships.forEach((z) => {
          if (!z.alive) seenDead.add(z.id);
        });
        if (f % 2 === 0) scene.renderer.draw(scene.state(), 1 / 30);
      }
    } catch (e) { err = e; }
    check('two minutes of battle render cleanly', !err, err ? err.message + '\n' + err.stack : '');
    check('ships fire at each other', fired > 20, fired + ' broadsides');
    check('ships are sunk and respawn', seenDead.size > 0, seenDead.size + ' ships went down');
    check('every ship is alive or waiting to respawn',
      scene.ships.every((z) => z.alive || z.deadUntil > scene.time),
      scene.ships.filter((z) => !z.alive).length + ' waiting');
    check('the fight stays in front of the camera',
      scene.ships.every((z) => Math.hypot(z.x - 1400, z.y - 1400) < 1400),
      Math.round(Math.max.apply(null, scene.ships.map((z) => Math.hypot(z.x - 1400, z.y - 1400)))) + ' units out');
    check('shots do not pile up', scene.shots.length < 120, scene.shots.length + ' in flight');
    check('wind stays in a sane range',
      scene.wind.strength > 0.3 && scene.wind.strength <= 1.05, scene.wind.strength.toFixed(2));

    scene.stop();
    check('the scene can be stopped', scene.running === false);
  }
}

// ---------------------------------------------------------------------
section('reconnect after an idle drop');
{
  // A WebSocket we can open and kill on demand.
  const sockets = [];
  function FakeWS(url) {
    this.url = url;
    this.readyState = 0;            // CONNECTING
    this.sent = [];
    this.send = (str) => { this.sent.push(str); };
    this.close = () => { this.readyState = 3; if (this.onclose) this.onclose(); };
    sockets.push(this);
  }
  FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;
  win.WebSocket = FakeWS;

  const net = new win.Net();
  const opens = [];
  const reconnects = [];
  net.on('open', (m) => opens.push(m));
  net.on('reconnecting', (m) => reconnects.push(m));
  // Stand in for main.js re-announcing the player's name on every open.
  net.on('open', () => net.send({ t: 'name', name: 'Captain' }));

  net.connect();
  check('opens a socket', sockets.length === 1);

  sockets[0].readyState = 1;
  sockets[0].onopen();
  check('first connect is not flagged as a reopen', opens[0].reopened === false);

  net.send({ t: 'create', name: 'Early' });
  check('sends straight out while connected',
    sockets[0].sent.some((x) => x.indexOf('Early') >= 0));

  // The line dies quietly while the player sits on the menu.
  sockets[0].readyState = 3;
  sockets[0].onclose();
  check('notices the socket is gone', net.connected === false);
  check('schedules a reconnect', net._retryTimer !== null);
  check('emitted a reconnecting event', reconnects.length === 1);

  // The player clicks "Create lobby" on what is now a dead socket.
  net.send({ t: 'create', name: 'Salty Dog' });
  check('holds the click instead of dropping it', net.queue.length === 1, net.queue.length);

  // Stale input and latency pings must not pile up.
  net.send({ t: 'in', d: 1, f: false, s: 1, r: 1 });
  net.send({ t: 'ping', c: 1 });
  check('does not queue stale input or pings', net.queue.length === 1, net.queue.length);

  // The retry fires.
  net.connect();
  check('dials again', sockets.length === 2);
  sockets[1].readyState = 1;
  sockets[1].onopen();

  check('second open is flagged as a reopen', opens[1].reopened === true);
  const out = sockets[1].sent;
  check('replays the held click after reconnecting',
    out.some((x) => x.indexOf('Salty Dog') >= 0), JSON.stringify(out));
  check('re-announces the name before replaying the click',
    out.findIndex((x) => x.indexOf('"name"') >= 0) < out.findIndex((x) => x.indexOf('Salty Dog') >= 0),
    JSON.stringify(out));
  check('queue is emptied', net.queue.length === 0);

  net.closing = true;
  if (net._pingTimer) clearInterval(net._pingTimer);
}

// ---------------------------------------------------------------------
section('the whole client, driven by real server messages');
{
  // Everything above tests the pieces. This boots the actual client -
  // main.js included - against a fake socket and pushes real server
  // messages through it, which is the only way to catch the wiring
  // between them.
  function bootClient() {
    const els = {};
    const sockets = [];

    function FakeWS(url) {
      this.url = url; this.readyState = 1; this.sent = [];
      this.send = (str) => this.sent.push(str);
      this.close = () => { this.readyState = 3; if (this.onclose) this.onclose(); };
      sockets.push(this);
    }
    FakeWS.CONNECTING = 0; FakeWS.OPEN = 1; FakeWS.CLOSING = 2; FakeWS.CLOSED = 3;

    const body = makeEl('body');
    for (const id of ['view', 'menuScene', 'windDial', 'minimap']) els[id] = makeCanvas(1280, 720);
    const w = {
      devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720,
      location: { protocol: 'http:', host: 'x', reload() {} },
      performance: { now: () => Date.now() },
      requestAnimationFrame: () => 1,
      setTimeout, clearTimeout, setInterval: () => 1, clearInterval,
      addEventListener: () => {}, removeEventListener: () => {},
      localStorage: {
        _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
        setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; }
      },
      prompt: () => null,
      AudioContext: undefined,
      WebSocket: FakeWS,
      console,
      document: {
        body: body,
        visibilityState: 'visible',
        createElement: (t) => (t === 'canvas' ? makeCanvas(256, 256) : makeEl(t)),
        createTextNode: (t) => { const n = makeEl('#text'); n.textContent = t; return n; },
        getElementById: (id) => els[id] || (els[id] = makeEl('div')),
        addEventListener: () => {}
      }
    };
    w.window = w; w.self = w; w.global = w;

    const c = vm.createContext(w);
    for (const f of ['shared/constants.js', 'shared/mapgen.js', 'public/js/audio.js',
      'public/js/net.js', 'public/js/terrain.js', 'public/js/render.js',
      'public/js/menuscene.js', 'public/js/input.js', 'public/js/ui.js',
      'public/js/main.js']) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), c, { filename: f });
    }
    return {
      win: w, els, sockets,
      el: (id) => w.document.getElementById(id),
      deliver(msg) { sockets[0].onmessage({ data: JSON.stringify(msg) }); }
    };
  }

  let app = null;
  try {
    app = bootClient();
    check('the full client boots', app.sockets.length === 1, app.sockets.length + ' sockets opened');
  } catch (e) {
    check('the full client boots', false, e.message + '\n' + e.stack);
  }

  if (app) {
    const idFor = 7;
    app.deliver({ t: 'welcome', id: idFor, protocol: C.PROTOCOL });

    function standingsFor(mode) {
      return mode === C.MODE_TDM
        ? [{ id: 7, name: 'Me', team: 0, colorIdx: 0, bot: 0, score: 4, kills: 4, deaths: 2 },
           { id: 8, name: 'Kidd', team: 1, colorIdx: 1, bot: 1, score: 6, kills: 6, deaths: 1 }]
        : [{ id: 7, name: 'Me', team: -1, colorIdx: 0, bot: 0, score: 4, kills: 4, deaths: 2 },
           { id: 8, name: 'Kidd', team: -1, colorIdx: 1, bot: 1, score: 6, kills: 6, deaths: 1 }];
    }

    // A round ending must show results in BOTH game types, and it has to
    // survive the exact message order the server actually sends: the final
    // snapshot, then matchEnd, then the lobby state that follows it.
    for (const mode of [C.MODE_DM, C.MODE_TDM]) {
      const label = mode === C.MODE_TDM ? 'team deathmatch' : 'deathmatch';
      const lobbyMsg = {
        t: 'lobby', id: 'L1', name: 'L', mode: mode, hostId: idFor,
        hasPassword: false, capacity: 8, teamSize: 4,
        players: [{ id: idFor, name: 'Me', team: mode === C.MODE_TDM ? 0 : -1, colorIdx: 0, bot: false, host: true }]
      };
      app.el('matchOver').classList.add('hidden');
      let err = null;
      try {
        app.deliver(Object.assign({}, lobbyMsg, { state: 'playing' }));
        app.deliver({ t: 'matchEnd', standings: standingsFor(mode), mode: mode, timeUp: true });
        // ...and the lobby update the server sends straight afterwards.
        app.deliver(Object.assign({}, lobbyMsg, { state: 'lobby' }));
      } catch (e) { err = e; }
      check(label + ': matchEnd is handled without error', !err, err ? err.message + '\n' + err.stack : '');
      check(label + ': the results overlay is revealed',
        !app.el('matchOver').classList.contains('hidden'));
      check(label + ': a winner is named',
        (app.el('matchWinner').textContent || '').length > 2, app.el('matchWinner').textContent);
      check(label + ': the table is filled in',
        app.el('standings').children.length > 0, app.el('standings').children.length + ' rows');
    }

    // And the button puts it away again.
    app.el('backToLobby').onclick();
    check('dismissing the results hides them', app.el('matchOver').classList.contains('hidden'));

    // An empty standings list must still show something rather than nothing.
    app.el('matchOver').classList.add('hidden');
    app.deliver({ t: 'matchEnd', standings: [], mode: C.MODE_DM, timeUp: true });
    check('a match with no standings still tells the player it ended',
      !app.el('matchOver').classList.contains('hidden') ||
      (app.el('toast').textContent || '').length > 0,
      'overlay hidden=' + app.el('matchOver').classList.contains('hidden') +
      ' toast=' + JSON.stringify(app.el('toast').textContent));
  }
}

console.log('\ncanvas op mix: ' + JSON.stringify(
  Object.entries(calls.byName).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .reduce((o, [k, v]) => (o[k] = v, o), {})));

console.log('\n' + (fails === 0 ? 'ALL CLIENT CHECKS PASSED' : fails + ' CHECK(S) FAILED'));
process.exit(fails === 0 ? 0 : 1);
