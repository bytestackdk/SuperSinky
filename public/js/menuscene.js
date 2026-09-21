/* Super Sinky - the battle playing behind the front page.
 *
 * This drives the real game renderer with a small throwaway simulation, so
 * the menu shows the actual ship art, sea, smoke and gulls rather than a
 * static picture. Nothing here touches the server or the real game state.
 */
(function (global) {
  'use strict';

  var C = global.SSConst;
  var TAU = Math.PI * 2;

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(a) { return a[(Math.random() * a.length) | 0]; }
  function angDiff(a, b) {
    var d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    return d;
  }

  var CENTRE = 1400;          // the diorama lives in its own little sea
  var FIELD = 620;            // how far the ships range from the centre

  function MenuScene(canvas) {
    this.canvas = canvas;
    this.renderer = new global.Renderer(canvas);
    this.renderer.showEdge = false;      // no map border out here
    this.renderer.showNames = false;     // keep the menu uncluttered
    this.renderer.cam.zoom = 0.82;
    this.renderer.cam.x = CENTRE;
    this.renderer.cam.y = CENTRE;

    this.ships = [];
    this.shots = [];
    this.wind = { dir: Math.random() * TAU, strength: 0.85 };
    this.windTarget = this.wind.dir;
    this.windChangeAt = 6;
    this.time = 0;
    this.running = false;
    this.last = 0;
    this.camAngle = Math.random() * TAU;

    this._build();

    var self = this;
    global.addEventListener('resize', function () {
      if (self.running) self.renderer.resize();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && self.running) self.last = 0;
    });
  }

  MenuScene.prototype._build = function () {
    var n = 7;
    for (var i = 0; i < n; i++) {
      var team = i % 2;
      var a = (i / n) * TAU + rnd(-0.2, 0.2);
      var d = rnd(FIELD * 0.35, FIELD * 0.85);
      this.ships.push(this._makeShip(i + 1, team, CENTRE + Math.cos(a) * d, CENTRE + Math.sin(a) * d));
    }
  };

  MenuScene.prototype._makeShip = function (id, team, x, y) {
    return {
      id: id, team: team,
      color: C.TEAM_COLORS[team],
      x: x, y: y,
      angle: Math.random() * TAU,
      speed: 60,
      hp: C.SHIP_HP,
      alive: true,
      deadUntil: 0,
      side: Math.random() < 0.5 ? 1 : -1,
      cannons: 2 + ((Math.random() * 3) | 0),
      sails: (Math.random() * 4) | 0,
      superTime: Math.random() < 0.25 ? rnd(4, 14) : 0,
      rapid: (Math.random() * 3) | 0,
      regen: false,
      reload: 1,
      reloadAt: rnd(0, 2),
      protect: false,
      boosting: false,
      boost: 1,
      score: 0,
      respawnIn: 0,
      name: '',
      isBot: true
    };
  };

  MenuScene.prototype._respawn = function (s) {
    var a = Math.random() * TAU;
    var d = rnd(FIELD * 0.55, FIELD);
    s.x = CENTRE + Math.cos(a) * d;
    s.y = CENTRE + Math.sin(a) * d;
    s.angle = a + Math.PI + rnd(-0.6, 0.6);
    s.hp = C.SHIP_HP;
    s.alive = true;
    s.speed = 60;
    s.cannons = 2 + ((Math.random() * 3) | 0);
    s.sails = (Math.random() * 4) | 0;
    s.superTime = Math.random() < 0.25 ? rnd(4, 14) : 0;
    s.rapid = (Math.random() * 3) | 0;
    s.boosting = false;
    this.renderer.particles.burst('splash', s.x, s.y);
  };

  MenuScene.prototype._nearestEnemy = function (s) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < this.ships.length; i++) {
      var o = this.ships[i];
      if (!o.alive || o.team === s.team) continue;
      var d = Math.hypot(o.x - s.x, o.y - s.y);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  };

  MenuScene.prototype.update = function (dt) {
    this.time += dt;
    var R = this.renderer;

    // Wind wanders, as in the real game.
    if (this.time >= this.windChangeAt) {
      this.windChangeAt = this.time + rnd(7, 16);
      this.windTarget = this.wind.dir + rnd(-1.3, 1.3);
    }
    this.wind.dir += Math.max(-0.35 * dt, Math.min(0.35 * dt, angDiff(this.windTarget, this.wind.dir)));
    this.wind.strength = 0.78 + 0.2 * Math.sin(this.time * 0.17);

    for (var i = 0; i < this.ships.length; i++) {
      var s = this.ships[i];

      if (!s.alive) {
        if (this.time >= s.deadUntil) this._respawn(s);
        continue;
      }
      if (s.superTime > 0) s.superTime = Math.max(0, s.superTime - dt);

      var target = this._nearestEnemy(s);
      var desired = s.angle;

      if (target) {
        var dx = target.x - s.x, dy = target.y - s.y;
        var dist = Math.hypot(dx, dy);
        var toTarget = Math.atan2(dy, dx);

        var port = angDiff(toTarget, s.angle - Math.PI / 2);
        var stbd = angDiff(toTarget, s.angle + Math.PI / 2);
        s.side = Math.abs(stbd) <= Math.abs(port) ? 1 : -1;

        // Circle at a comfortable distance so the guns keep bearing.
        var closing = Math.max(-1, Math.min(1, (dist - 300) / 260));
        desired = toTarget - s.side * (Math.PI / 2) * (1 - closing * 0.75);

        var bearing = s.side === 1 ? stbd : port;
        if (this.time >= s.reloadAt && Math.abs(bearing) < 0.30 && dist < C.RANGE) {
          this._fire(s);
        }
      }

      // Keep the fight in shot of the camera.
      var fromCentre = Math.hypot(s.x - CENTRE, s.y - CENTRE);
      if (fromCentre > FIELD) {
        desired = Math.atan2(CENTRE - s.y, CENTRE - s.x) + rnd(-0.4, 0.4);
      }

      var turn = angDiff(desired, s.angle);
      s.angle += Math.max(-1.5 * dt, Math.min(1.5 * dt, turn));

      var eff = 0.4 + 0.6 * ((Math.cos(s.angle - this.wind.dir) + 1) / 2);
      var want = C.BASE_SPEED * 0.78 * eff * (1 + s.sails * 0.12);
      s.speed += (want - s.speed) * Math.min(1, 1.6 * dt);
      s.x += Math.cos(s.angle) * s.speed * dt;
      s.y += Math.sin(s.angle) * s.speed * dt;

      var reloadTime = C.RELOAD * Math.pow(1 - C.RAPID_BONUS, s.rapid);
      s.reload = Math.max(0, Math.min(1, 1 - (s.reloadAt - this.time) / reloadTime));
    }

    this._updateShots(dt);
  };

  MenuScene.prototype._fire = function (s) {
    var R = this.renderer;
    s.reloadAt = this.time + C.RELOAD * Math.pow(1 - C.RAPID_BONUS, s.rapid) * rnd(0.9, 1.3);
    var perp = s.angle + s.side * Math.PI / 2;
    var superShot = s.superTime > 0;

    for (var i = 0; i < s.cannons; i++) {
      var t = s.cannons === 1 ? 0 : (i / (s.cannons - 1)) * 2 - 1;
      var along = t * (C.SHIP_HALF_LEN - 8);
      var ox = Math.cos(s.angle) * along + Math.cos(perp) * (C.SHIP_HALF_BEAM + 4);
      var oy = Math.sin(s.angle) * along + Math.sin(perp) * (C.SHIP_HALF_BEAM + 4);
      var dir = perp + rnd(-C.SPREAD, C.SPREAD);

      this.shots.push({
        id: (Math.random() * 1e9) | 0,
        owner: s.id, team: s.team,
        x: s.x + ox, y: s.y + oy,
        vx: Math.cos(dir) * C.BALL_SPEED,
        vy: Math.sin(dir) * C.BALL_SPEED,
        travelled: 0, maxDist: C.RANGE * rnd(0.8, 1.0),
        superShot: superShot, prog: 0
      });

      R.particles.burst('smoke', s.x + ox + Math.cos(perp) * 12, s.y + oy + Math.sin(perp) * 12, {
        count: 5, dir: perp, power: 1.3, col: superShot ? '255,190,140' : '235,232,224'
      });
    }
  };

  MenuScene.prototype._updateShots = function (dt) {
    var R = this.renderer;
    var out = [];

    for (var i = 0; i < this.shots.length; i++) {
      var p = this.shots[i];
      var step = C.BALL_SPEED * dt;
      p.x += (p.vx / C.BALL_SPEED) * step;
      p.y += (p.vy / C.BALL_SPEED) * step;
      p.travelled += step;
      p.prog = Math.min(1, p.travelled / p.maxDist);

      var done = false;
      for (var j = 0; j < this.ships.length; j++) {
        var s = this.ships[j];
        if (!s.alive || s.id === p.owner || s.team === p.team) continue;
        if (Math.hypot(s.x - p.x, s.y - p.y) > C.SHIP_HALF_LEN * 0.8) continue;

        s.hp -= C.BALL_DAMAGE * (p.superShot ? C.SUPER_MULT : 1);
        R.particles.burst('explode', p.x, p.y, { count: p.superShot ? 20 : 13 });
        if (s.hp <= 0) {
          R.explodeShip(s.x, s.y, s.angle, s.color);
          s.alive = false;
          s.deadUntil = this.time + rnd(2.5, 5);
        }
        done = true;
        break;
      }

      if (!done && p.travelled >= p.maxDist) {
        R.particles.burst('splash', p.x, p.y);
        done = true;
      }
      if (!done) out.push(p);
    }
    this.shots = out;
  };

  MenuScene.prototype.state = function () {
    var alive = [];
    for (var i = 0; i < this.ships.length; i++) alive.push(this.ships[i]);
    return {
      ships: alive,
      projectiles: this.shots,
      powerups: [],
      whirlpools: [],
      wind: this.wind,
      me: null,
      meId: -1,
      mode: C.MODE_TDM,
      focus: null
    };
  };

  MenuScene.prototype.frame = function (now) {
    if (!this.running) return;
    global.requestAnimationFrame(this.frame.bind(this));

    if (!this.last) { this.last = now; return; }
    var dt = (now - this.last) / 1000;
    // Idle menu: half frame rate is plenty and keeps laptops quiet.
    if (dt < 1 / 32) return;
    this.last = now;
    dt = Math.min(0.08, dt);

    this.update(dt);

    // Drift the camera slowly around the action.
    this.camAngle += dt * 0.045;
    this.renderer.cam.x = CENTRE + Math.cos(this.camAngle) * 150;
    this.renderer.cam.y = CENTRE + Math.sin(this.camAngle * 0.8) * 110;

    this.renderer.draw(this.state(), dt);
  };

  MenuScene.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    this.renderer.resize();
    global.requestAnimationFrame(this.frame.bind(this));
  };

  MenuScene.prototype.stop = function () { this.running = false; };

  global.MenuScene = MenuScene;
})(window);
