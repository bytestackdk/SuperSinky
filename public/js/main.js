/* Super Sinky - client bootstrap: menu flow, interpolation and the frame loop. */
(function (global) {
  'use strict';

  var C = global.SSConst;
  var UI = global.UI;
  var $ = UI.$;
  var TAU = Math.PI * 2;
  var NAME_KEY = 'supersinky.name';
  // Further than any ship could travel between two snapshots, so crossing it
  // means she was moved rather than sailed.
  var TELEPORT_DIST = 150;
  var MUTE_KEY = 'supersinky.muted';

  var net = new global.Net();
  var input = new global.Input(net);
  var renderer = null;
  var snapshots = new global.SnapshotBuffer();

  var app = {
    myId: 0,
    name: '',
    lobby: null,           // last lobby state
    mode: C.MODE_DM,
    roster: {},            // shipId -> meta
    inGame: false,
    terrain: null,
    loading: 0,
    lastFrame: 0,
    lastCam: { x: C.WORLD / 2, y: C.WORLD / 2 },
    pendingJoin: null,
    wasReloading: false,
    wasBoosting: false
  };

  // =====================================================================
  // Helpers
  // =====================================================================

  function shortAngleLerp(a, b, t) {
    var d = b - a;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return a + d * t;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function metaFor(id) {
    return app.roster[id] || { name: 'Unknown', team: -1, colorIdx: 0, isBot: false };
  }

  function colorOf(id) {
    var m = metaFor(id);
    if (app.mode === C.MODE_TDM && m.team >= 0) return C.TEAM_COLORS[m.team];
    return C.FFA_COLORS[m.colorIdx % C.FFA_COLORS.length];
  }

  function setRoster(list) {
    app.roster = {};
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      app.roster[r.i] = { name: r.n, team: r.t, colorIdx: r.c, isBot: !!r.b };
    }
  }

  // =====================================================================
  // Snapshot -> view state
  // =====================================================================

  function indexShips(snap) {
    var map = {};
    for (var i = 0; i < snap.sh.length; i++) map[snap.sh[i][0]] = snap.sh[i];
    return map;
  }

  function buildViewState() {
    var s = snapshots.sample();
    if (!s) return null;

    var A = s.a, B = s.b, t = s.t;
    var aShips = indexShips(A);
    var ships = [];

    for (var i = 0; i < B.sh.length; i++) {
      var b = B.sh[i];
      var a = aShips[b[0]] || b;
      var meta = metaFor(b[0]);

      // A respawn puts the ship somewhere else entirely. Interpolating across
      // that jump drew her streaking over the map for a frame, which looked
      // like a ship flickering into existence in the wrong place - so snap to
      // the new state instead. The same applies when she sinks or respawns,
      // where the two snapshots describe different lives.
      var blend = t;
      if (a !== b) {
        var jump = Math.hypot(b[1] - a[1], b[2] - a[2]);
        if (jump > TELEPORT_DIST || a[9] !== b[9]) blend = 1;
      }

      ships.push({
        id: b[0],
        x: lerp(a[1], b[1], blend),
        y: lerp(a[2], b[2], blend),
        angle: shortAngleLerp(a[3], b[3], blend),
        hp: lerp(a[4], b[4], blend),
        side: b[5],
        cannons: b[6],
        sails: b[7],
        superTime: b[8],
        alive: !!b[9],
        respawnIn: b[10],
        reload: b[11],
        score: b[12],
        protect: !!b[13],
        speed: b[14],
        boost: b[15],
        boosting: !!b[16],
        rapid: b[17],
        regen: !!b[18],
        name: meta.name,
        team: meta.team,
        isBot: meta.isBot,
        color: colorOf(b[0])
      });
    }

    // Projectiles move fast and live briefly: dead-reckon from the newest
    // snapshot instead of interpolating, so they never lag behind the boom.
    var age = (performance.now() - B._recv) / 1000;
    var projectiles = [];
    for (var j = 0; j < B.pr.length; j++) {
      var p = B.pr[j];
      projectiles.push({
        id: p[0],
        x: p[1] + p[3] * age,
        y: p[2] + p[4] * age,
        vx: p[3], vy: p[4],
        superShot: !!p[5],
        prog: Math.min(1, p[6] + age * (C.BALL_SPEED / C.RANGE))
      });
    }

    var powerups = [];
    for (var k = 0; k < B.pu.length; k++) {
      var q = B.pu[k];
      powerups.push({ id: q[0], x: q[1], y: q[2], type: q[3] });
    }

    var whirlpools = [];
    for (var m = 0; m < B.wp.length; m++) {
      var w = B.wp[m];
      whirlpools.push({ id: w[0], x: w[1], y: w[2], r: w[3], phase: w[4] + age * 1.1, fade: w[5] });
    }

    var wind = { dir: shortAngleLerp(A.w[0], B.w[0], t), strength: lerp(A.w[1], B.w[1], t) };

    // The battle area: interpolated so the boundary slides rather than steps.
    var zone = null;
    if (B.sz) {
      zone = A.sz
        ? [lerp(A.sz[0], B.sz[0], t), lerp(A.sz[1], B.sz[1], t),
           lerp(A.sz[2], B.sz[2], t), lerp(A.sz[3], B.sz[3], t)]
        : B.sz.slice();
    }
    var timeLeft = B.rt === undefined ? 0 : Math.max(0, B.rt - age);
    var shrinks = B.sn || 0;
    var elapsed = C.ROUND_SECONDS - timeLeft;
    var nextShrinkIn = shrinks >= C.SHRINK_STEPS
      ? null
      : Math.max(0, (C.SHRINK_START + shrinks * C.SHRINK_EVERY) - elapsed);

    var me = null;
    for (var n = 0; n < ships.length; n++) if (ships[n].id === app.myId) me = ships[n];

    if (me && me.alive) { app.lastCam.x = me.x; app.lastCam.y = me.y; }

    return {
      ships: ships,
      projectiles: projectiles,
      powerups: powerups,
      whirlpools: whirlpools,
      wind: wind,
      me: me,
      meId: app.myId,
      mode: app.mode,
      focus: app.lastCam,
      zone: zone,
      timeLeft: timeLeft,
      shrinks: shrinks,
      nextShrinkIn: nextShrinkIn,
      meOutside: !!(me && me.alive && zone &&
        (me.x < zone[0] || me.y < zone[1] || me.x > zone[2] || me.y > zone[3]))
    };
  }

  // =====================================================================
  // Events -> sound & particles
  // =====================================================================

  function distanceVolume(x, y) {
    var dx = x - renderer.cam.x, dy = y - renderer.cam.y;
    var d = Math.hypot(dx, dy);
    var reach = 1500;
    if (d > reach) return 0;
    return Math.pow(1 - d / reach, 1.7);
  }

  /** Stereo placement from how far off to one side the sound is. */
  function panFor(x) {
    if (!renderer) return 0;
    return Math.max(-0.85, Math.min(0.85, (x - renderer.cam.x) / 700));
  }

  function processEvents(snap) {
    if (!snap.ev || !snap.ev.length) return;
    for (var i = 0; i < snap.ev.length; i++) {
      var e = snap.ev[i];
      var vol = (e.x !== undefined) ? distanceVolume(e.x, e.y) : 0.5;
      var pan = (e.x !== undefined) ? panFor(e.x) : 0;
      var P = renderer.particles;

      switch (e.k) {
        case 'fire':
          for (var g = 0; g < e.n; g++) {
            var off = (e.n === 1 ? 0 : (g / (e.n - 1)) * 2 - 1) * 20;
            var px = e.x + Math.cos(e.a + Math.PI / 2) * off;
            var py = e.y + Math.sin(e.a + Math.PI / 2) * off;
            P.burst('smoke', px + Math.cos(e.a) * 14, py + Math.sin(e.a) * 14, {
              count: 5, dir: e.a, power: 1.3, col: e.s ? '255,190,140' : '235,232,224'
            });
          }
          global.Sfx.play('fire', vol * 0.85, pan, e.n);
          break;

        case 'hit':
          P.burst('explode', e.x, e.y, { count: e.s ? 20 : 13 });
          global.Sfx.play('hit', vol, pan);
          if (vol > 0.55) renderer.shake = Math.min(1, renderer.shake + vol * 0.45);
          break;

        case 'splash':
          P.burst('splash', e.x, e.y);
          global.Sfx.play('splash', vol * 0.5, pan);
          break;

        case 'dirt':
          P.burst('dirt', e.x, e.y);
          global.Sfx.play('splash', vol * 0.35, pan);
          break;

        case 'rock':
          P.burst('dirt', e.x, e.y);
          P.burst('spark', e.x, e.y, { col: '210,200,180' });
          global.Sfx.play('rock', vol * 0.6, pan);
          break;

        case 'ram':
          P.burst('debris', e.x, e.y, { count: 9 });
          P.burst('splash', e.x, e.y);
          global.Sfx.play('ram', vol, pan);
          renderer.shake = Math.min(1, renderer.shake + vol * 0.5);
          break;

        case 'headon':
          P.burst('debris', e.x, e.y, { count: 12 });
          global.Sfx.play('ram', vol, pan);
          renderer.shake = Math.min(1, renderer.shake + vol * 0.6);
          break;

        case 'ground':
          P.burst('dirt', e.x, e.y);
          P.burst('splash', e.x, e.y);
          global.Sfx.play('ground', vol * 0.8, pan);
          break;

        case 'sink':
          onSink(e, vol);
          break;

        case 'spawn':
          P.burst('splash', e.x, e.y);
          global.Sfx.play('spawn', vol * 0.5, pan);
          break;

        case 'pickup':
          P.burst('spark', e.x, e.y, { col: '255,225,140' });
          renderer.addPickupFloater(e.p, e.x, e.y, e.v === app.myId);
          global.Sfx.play('pickup', e.v === app.myId ? 0.9 : vol * 0.6, panFor(e.x));
          break;

        case 'whirl':
          global.Sfx.play('whirl', vol * 0.8, pan);
          break;

        case 'shrink':
          UI.toast('The battle area is closing in (' + e.n + ' / ' + e.of + ')');
          global.Sfx.play('shrink', 0.85);
          break;

      }
    }
  }

  function onSink(e, vol) {
    var victim = metaFor(e.v);
    var killer = e.by ? metaFor(e.by) : null;
    renderer.explodeShip(e.x, e.y, e.a, colorOf(e.v));
    var own = e.v === app.myId || e.by === app.myId;
    var epan = panFor(e.x);
    global.Sfx.play('explode', Math.max(vol, own ? 1 : 0), epan);
    global.Sfx.play('sink', Math.max(vol, e.v === app.myId ? 0.9 : 0), epan);
    renderer.shake = Math.min(1.6, own ? 1.6 : Math.max(renderer.shake, vol * 1.3));

    var vcol = colorOf(e.v);
    var html;
    if (killer && e.by !== e.v) {
      var kcol = colorOf(e.by);
      var verb = e.tk ? 'sank their own' : (e.c === 'ram' ? 'rammed' : 'sank');
      html = '<b style="color:' + kcol + '">' + esc(killer.name) + '</b>' +
        '<span class="verb">' + verb + '</span>' +
        '<b style="color:' + vcol + '">' + esc(victim.name) + '</b>';
    } else {
      var cause = e.c === 'whirlpool' ? 'was swallowed by a whirlpool'
        : (e.c === 'ground' ? 'ran aground' : 'went down');
      html = '<b style="color:' + vcol + '">' + esc(victim.name) + '</b>' +
        '<span class="verb">' + cause + '</span>';
    }
    UI.pushKill(html, !!e.tk);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // =====================================================================
  // Frame loop
  // =====================================================================

  function frame(now) {
    requestAnimationFrame(frame);
    if (!app.inGame || !renderer) return;

    var dt = Math.min(0.05, (now - app.lastFrame) / 1000 || 0.016);
    app.lastFrame = now;

    if (!app.terrain || !app.terrain.ready) { drawLoading(); return; }

    // Fire off effects for any snapshot the render clock has now reached.
    var renderTime = performance.now() - 90;
    for (var i = 0; i < snapshots.buf.length; i++) {
      var s = snapshots.buf[i];
      if (!s._evDone && s._recv <= renderTime) { s._evDone = true; processEvents(s); }
    }

    var state = buildViewState();
    if (!state) return;

    renderer.draw(state, dt);

    UI.updateHud(state);
    renderer.drawWindDial($('windDial'), state.wind, state.me ? state.me.angle : null);
    renderer.drawMinimap($('minimap'), state);

    // A short chime the moment the guns come back up.
    if (state.me) {
      var ready = state.me.reload >= 1;
      if (ready && app.wasReloading && state.me.alive) global.Sfx.play('ready', 0.5);
      app.wasReloading = !ready;

      // And a surge of water the moment the boost engages.
      if (state.me.boosting && !app.wasBoosting) global.Sfx.play('boost', 0.75);
      app.wasBoosting = state.me.boosting;
    }
  }

  function drawLoading() {
    var canvas = $('view');
    var ctx = canvas.getContext('2d');
    var dpr = Math.min(2, global.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.fillStyle = '#06253c';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#f2ead6';
    ctx.textAlign = 'center';
    ctx.font = '22px "Trebuchet MS", sans-serif';
    ctx.fillText('Charting the waters...', w / 2, h / 2 - 22);
    var bw = Math.min(360, w * 0.6);
    ctx.strokeStyle = 'rgba(217,164,65,0.6)';
    ctx.lineWidth = 2;
    ctx.strokeRect(w / 2 - bw / 2, h / 2, bw, 14);
    ctx.fillStyle = '#d9a441';
    ctx.fillRect(w / 2 - bw / 2 + 2, h / 2 + 2, (bw - 4) * app.loading, 10);
  }

  // =====================================================================
  // Network wiring
  // =====================================================================

  net.on('open', function (m) {
    // Re-announce who we are before anything the player queued goes out.
    var stored = localStorage.getItem(NAME_KEY);
    if (stored) net.send({ t: 'name', name: stored });

    if (!m.reopened) return;

    // The server gave us a new identity, so whatever lobby or match we were
    // in is gone. Put the player back at the harbour rather than leaving
    // them staring at a frozen sea.
    var wasPlaying = app.inGame;
    app.lobby = null;
    app.inGame = false;
    app.roster = {};
    snapshots.clear();
    input.setEnabled(false);
    input.reset();
    $('connLost').classList.add('hidden');
    showScreen('menu');
    net.send({ t: 'lobbies' });
    UI.toast(wasPlaying ? 'Reconnected \u2014 rejoin from the harbour' : 'Reconnected', true);
  });

  net.on('reconnecting', function () {
    if (app.inGame) $('connLost').classList.remove('hidden');
  });

  net.on('welcome', function (m) {
    app.myId = m.id;
    var stored = localStorage.getItem(NAME_KEY);
    if (stored) {
      $('playerName').value = stored;
      app.name = stored;
    }
  });

  net.on('name', function (m) {
    app.name = m.name;
    $('playerName').value = m.name;
    localStorage.setItem(NAME_KEY, m.name);
  });

  net.on('lobbies', function (m) {
    UI.renderLobbyList(m.list, function (l) { attemptJoin(l); });
  });

  net.on('lobby', function (m) {
    app.lobby = m;
    app.mode = m.mode;
    UI.renderLobby(m, app.myId);
    if (!app.inGame) showScreen('lobby');
  });

  net.on('joinFailed', function (m) {
    if (m.reason === 'password') {
      var pw = prompt('This lobby is password protected. Enter the password:');
      if (pw !== null) net.send({ t: 'join', id: m.id, password: pw });
    }
  });

  net.on('left', function () {
    app.lobby = null;
    app.inGame = false;
    input.setEnabled(false);
    showScreen('menu');
    net.send({ t: 'lobbies' });
  });

  net.on('error', function (m) { UI.toast(m.msg); });

  net.on('roster', function (m) { setRoster(m.roster); });

  net.on('start', function (m) {
    app.mode = m.mode;
    setRoster(m.roster);
    snapshots.clear();
    input.reset();

    $('matchOver').classList.add('hidden');
    showScreen('game');
    app.inGame = true;
    app.loading = 0;

    if (!renderer) {
      renderer = new global.Renderer($('view'));
      global.addEventListener('resize', function () { renderer.resize(); });
    }
    renderer.resize();
    renderer.particles.list.length = 0;
    renderer.wrecks.length = 0;
    renderer.gulls.length = 0;
    renderer.onFlock = function (fx, fy) {
      if (Math.random() < 0.7) global.Sfx.play('gull', distanceVolume(fx, fy) * 0.9, panFor(fx));
    };

    var terrain = new global.Terrain(m.map.def);
    app.terrain = terrain;
    terrain.buildAsync(
      function (p) { app.loading = p; },
      function (t) {
        renderer.setTerrain(t, m.map.decor);
        renderer.cam.x = app.lastCam.x;
        renderer.cam.y = app.lastCam.y;
        input.setEnabled(true);
        input.flush(true);
        global.Sfx.resume();
      }
    );
  });

  net.on('s', function (m) { snapshots.push(m); });

  net.on('matchEnd', function (m) {
    app.inGame = false;
    input.setEnabled(false);
    if (m && m.standings && m.standings.length) {
      UI.showStandings(m, app.myId);
    } else {
      showScreen('lobby');
      UI.toast('The match has ended', true);
    }
  });

  net.on('close', function () {
    input.setEnabled(false);
    // net reconnects on its own; the overlay clears when it succeeds.
    if (app.inGame) $('connLost').classList.remove('hidden');
  });

  // =====================================================================
  // Menu actions
  // =====================================================================

  function currentName() {
    var v = $('playerName').value.trim().slice(0, C.PLAYER_NAME_MAX);
    return v || 'Sailor';
  }

  function saveName() {
    var n = currentName();
    localStorage.setItem(NAME_KEY, n);
    net.send({ t: 'name', name: n });
    UI.toast('Name saved', true);
  }

  function attemptJoin(l) {
    if (l.hasPassword) {
      var pw = prompt('Password for "' + l.name + '":');
      if (pw === null) return;
      net.send({ t: 'join', id: l.id, password: pw });
    } else {
      net.send({ t: 'join', id: l.id });
    }
  }

  $('saveName').onclick = saveName;
  $('playerName').addEventListener('change', function () {
    localStorage.setItem(NAME_KEY, currentName());
    net.send({ t: 'name', name: currentName() });
  });
  $('playerName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveName();
  });

  $('refreshLobbies').onclick = function () { net.send({ t: 'lobbies' }); };

  $('createLobby').onclick = function () {
    var name = $('lobbyName').value.trim();
    if (!name) { UI.toast('Give your lobby a name'); $('lobbyName').focus(); return; }
    net.send({ t: 'name', name: currentName() });
    net.send({
      t: 'create',
      name: name,
      password: $('lobbyPassword').value,
      mode: $('lobbyMode').value
    });
  };

  $('lobbyName').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('createLobby').click();
  });

  $('leaveLobby').onclick = function () { net.send({ t: 'leave' }); };

  // The per-team bot buttons in a team deathmatch lobby.
  UI.setBotHandler(function (action, team) { net.send({ t: action, team: team }); });
  $('endMatch').onclick = function () { net.send({ t: 'endMatch' }); };
  $('addBot').onclick = function () { net.send({ t: 'addBot' }); };
  $('removeBot').onclick = function () { net.send({ t: 'removeBot' }); };

  $('startGame').onclick = function () {
    if (app.lobby && app.lobby.state === 'playing') {
      // Already running - just drop back into the view.
      showScreen('game');
      app.inGame = true;
      input.setEnabled(true);
      return;
    }
    net.send({ t: 'start' });
  };

  $('backToLobby').onclick = function () {
    $('matchOver').classList.add('hidden');
    showScreen('lobby');
  };

  $('reconnectBtn').onclick = function () {
    $('connLost').classList.add('hidden');
    app.inGame = false;
    input.setEnabled(false);
    showScreen('menu');
    net.ensureConnected();
    net.send({ t: 'lobbies' });
  };

  // Coming back to a backgrounded tab, or back onto a network, should not
  // need a page refresh: reconnect at once and refresh the lobby list.
  function wakeUp() {
    if (document.visibilityState === 'hidden') return;
    if (!net.connected) net.ensureConnected();
    else if (!app.inGame) net.send({ t: 'lobbies' });
  }
  document.addEventListener('visibilitychange', wakeUp);
  global.addEventListener('online', wakeUp);
  global.addEventListener('focus', wakeUp);

  // ---- in-game keys handled by Input ----
  input.onEsc = function () {
    if (!app.inGame) return;
    app.inGame = false;
    input.setEnabled(false);
    showScreen('lobby');
  };

  input.onToggleHelp = function () { $('helpBox').classList.toggle('hidden'); };

  input.onToggleMute = function () {
    var m = global.Sfx.toggle();
    localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    UI.toast(m ? 'Sound off' : 'Sound on', !m);
  };

  // Any click or key press unlocks WebAudio.
  ['pointerdown', 'keydown'].forEach(function (evt) {
    global.addEventListener(evt, function () { global.Sfx.resume(); }, { once: true });
  });

  // =====================================================================
  // Boot
  // =====================================================================

  // The battle behind the front page. Purely decorative, and paused the
  // moment a real match is on screen.
  var menuScene = null;
  try {
    menuScene = new global.MenuScene($('menuScene'));
    menuScene.start();
  } catch (e) {
    var bg = $('menuScene');
    if (bg && bg.style) bg.style.display = 'none';
  }

  function setInGame(on) {
    document.body.classList.toggle('in-game', !!on);
    if (!menuScene) return;
    if (on) menuScene.stop(); else menuScene.start();
  }

  function showScreen(name) {
    UI.showScreen(name);
    setInGame(name === 'game');
  }

  if (localStorage.getItem(MUTE_KEY) === '1') global.Sfx.setMuted(true);

  var savedName = localStorage.getItem(NAME_KEY);
  if (savedName) $('playerName').value = savedName;

  net.connect();
  requestAnimationFrame(function (t) { app.lastFrame = t; frame(t); });
})(window);
