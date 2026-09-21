/* Super Sinky - canvas renderer.
 *
 * View is top-down tilted back slightly: the world is squashed vertically by
 * TILT and anything with height (cliffs, masts, buildings) is lifted up the
 * screen, which reads as a low camera angle without needing real 3D.
 */
(function (global) {
  'use strict';

  var C = global.SSConst;
  var M = global.SSMap;
  var TAU = Math.PI * 2;
  var TILT = 0.72;
  var BAKE = 0.75;

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  // =====================================================================
  // Particles
  // =====================================================================

  function Particles() { this.list = []; }

  Particles.prototype.spawn = function (p) {
    if (this.list.length > 900) this.list.shift();
    this.list.push(p);
  };

  Particles.prototype.update = function (dt, windDir, windStrength) {
    var wx = Math.cos(windDir) * windStrength * 26;
    var wy = Math.sin(windDir) * windStrength * 26;
    var out = [];
    for (var i = 0; i < this.list.length; i++) {
      var p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.drift) { p.x += wx * dt * p.drift; p.y += wy * dt * p.drift; }
      p.vx *= p.damp; p.vy *= p.damp;
      if (p.grav) p.z = (p.z || 0) + (p.vz = (p.vz || 0) - p.grav * dt) * dt;
      if (p.rot !== undefined) p.rot += p.spin * dt;
      out.push(p);
    }
    this.list = out;
  };

  Particles.prototype.burst = function (kind, x, y, opts) {
    opts = opts || {};
    var i, a, s;
    switch (kind) {
      case 'smoke':
        for (i = 0; i < (opts.count || 8); i++) {
          a = (opts.dir || 0) + rnd(-0.5, 0.5);
          s = rnd(20, 70) * (opts.power || 1);
          this.spawn({
            t: 'smoke', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.8, 1.7), max: 1.7, r: rnd(5, 11), damp: 0.93, drift: 0.9,
            col: opts.col || '230,228,220'
          });
        }
        break;
      case 'splash':
        for (i = 0; i < 12; i++) {
          a = Math.random() * TAU; s = rnd(30, 95);
          this.spawn({
            t: 'drop', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.3, 0.6), max: 0.6, r: rnd(1.4, 3), damp: 0.9, z: 0, vz: rnd(30, 70), grav: 160
          });
        }
        this.spawn({ t: 'ring', x: x, y: y, vx: 0, vy: 0, life: 0.75, max: 0.75, r: 4, damp: 1 });
        break;
      case 'dirt':
        for (i = 0; i < 10; i++) {
          a = Math.random() * TAU; s = rnd(20, 70);
          this.spawn({
            t: 'smoke', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.4, 0.9), max: 0.9, r: rnd(3, 7), damp: 0.9, drift: 0.4,
            col: '156,134,102'
          });
        }
        break;
      case 'explode':
        for (i = 0; i < (opts.count || 14); i++) {
          a = Math.random() * TAU; s = rnd(40, 150);
          this.spawn({
            t: 'fire', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.22, 0.5), max: 0.5, r: rnd(3, 8), damp: 0.88
          });
        }
        for (i = 0; i < 9; i++) {
          a = Math.random() * TAU; s = rnd(15, 60);
          this.spawn({
            t: 'smoke', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.7, 1.6), max: 1.6, r: rnd(5, 12), damp: 0.92, drift: 0.8,
            col: '70,64,60'
          });
        }
        break;
      case 'debris':
        for (i = 0; i < (opts.count || 16); i++) {
          a = Math.random() * TAU; s = rnd(25, 110);
          this.spawn({
            t: 'plank', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(1.4, 3.2), max: 3.2, r: rnd(3, 7), damp: 0.95,
            rot: Math.random() * TAU, spin: rnd(-3, 3), col: opts.col || '120,80,44'
          });
        }
        break;
      case 'bubble':
        for (i = 0; i < (opts.count || 6); i++) {
          this.spawn({
            t: 'bubble', x: x + rnd(-18, 18), y: y + rnd(-10, 10), vx: 0, vy: 0,
            life: rnd(0.6, 1.4), max: 1.4, r: rnd(1.5, 4.5), damp: 1
          });
        }
        break;
      case 'spark':
        for (i = 0; i < 10; i++) {
          a = Math.random() * TAU; s = rnd(30, 80);
          this.spawn({
            t: 'spark', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.3, 0.7), max: 0.7, r: rnd(1.5, 3), damp: 0.9,
            col: opts.col || '255,220,120'
          });
        }
        break;
      case 'wake':
        this.spawn({
          t: 'wake', x: x, y: y, vx: opts.vx || 0, vy: opts.vy || 0,
          life: 1.5, max: 1.5, r: opts.r || 6, damp: 0.96
        });
        break;

      // The magazine going up: a flash, a shockwave, a fireball that climbs,
      // then a long column of smoke over the wreck.
      case 'blast':
        this.spawn({ t: 'flash', x: x, y: y, vx: 0, vy: 0, life: 0.20, max: 0.20, r: 95, damp: 1 });
        this.spawn({ t: 'shock', x: x, y: y, vx: 0, vy: 0, life: 0.65, max: 0.65, r: 14, damp: 1 });
        this.spawn({ t: 'shock', x: x, y: y, vx: 0, vy: 0, life: 0.95, max: 0.95, r: 8, damp: 1 });

        for (i = 0; i < 34; i++) {
          a = Math.random() * TAU; s = rnd(30, 210);
          this.spawn({
            t: 'fire', x: x + rnd(-10, 10), y: y + rnd(-8, 8),
            vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.35, 0.95), max: 0.95, r: rnd(6, 17), damp: 0.90,
            z: 0, vz: rnd(10, 70), grav: 38
          });
        }
        for (i = 0; i < 26; i++) {
          a = Math.random() * TAU; s = rnd(10, 85);
          this.spawn({
            t: 'smoke', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(1.4, 3.0), max: 3.0, r: rnd(8, 20), damp: 0.93, drift: 1.1,
            col: i % 3 === 0 ? '104,96,90' : '54,50,48',
            z: 0, vz: rnd(14, 46), grav: 12
          });
        }
        for (i = 0; i < 16; i++) {
          a = Math.random() * TAU; s = rnd(60, 190);
          this.spawn({
            t: 'ember', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
            life: rnd(0.7, 1.7), max: 1.7, r: rnd(1.5, 3.4), damp: 0.94,
            z: 0, vz: rnd(40, 110), grav: 95
          });
        }
        break;
    }
  };

  // =====================================================================
  // Renderer
  // =====================================================================

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 0; this.h = 0; this.dpr = 1;
    this.cam = { x: C.WORLD / 2, y: C.WORLD / 2, zoom: 0.95 };
    this.terrain = null;
    this.decor = [];
    this.particles = new Particles();
    this.wrecks = [];
    this.trails = {};          // shipId -> the path she has cut through the water
    this.floaters = [];        // short-lived labels that rise off the water
    this.gulls = [];
    this.nextGullAt = 6;       // first flock shows up shortly after the start
    this.showEdge = true;      // the menu diorama has no map border to mark
    this.showNames = true;
    this.time = 0;
    this.shake = 0;
    this.waterPattern = null;
    this.streaks = [];
    this._initStreaks();
    this.resize();
  }

  Renderer.prototype._initStreaks = function () {
    for (var i = 0; i < 120; i++) {
      this.streaks.push({
        x: Math.random(), y: Math.random(),
        len: rnd(26, 78),
        a: rnd(0.20, 0.52),
        sp: rnd(0.7, 1.6),
        arrow: Math.random() < 0.11,     // just a few carry an arrowhead
        cap: Math.random() < 0.3         // some are whitecaps
      });
    }
  };

  Renderer.prototype.resize = function () {
    this.dpr = Math.min(2, global.devicePixelRatio || 1);
    var w = this.canvas.clientWidth || global.innerWidth;
    var h = this.canvas.clientHeight || global.innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.w = w; this.h = h;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.waterPattern = null;
  };

  Renderer.prototype.setTerrain = function (terrain, decor) {
    this.terrain = terrain;
    this.decor = decor || [];
    // Cache each decoration's ground elevation so it sits on its hillside.
    for (var i = 0; i < this.decor.length; i++) {
      var d = this.decor[i];
      var cx = Math.floor(d.x / C.FINE), cy = Math.floor(d.y / C.FINE);
      d.e = M.elevFromHeight(terrain.heightAtCell(cx, cy));
    }
    this.decor.sort(function (a, b) { return a.y - b.y; });
  };

  // ---- projection ----------------------------------------------------

  Renderer.prototype.sx = function (wx) { return (wx - this.cam.x) * this.cam.zoom + this.w / 2; };
  Renderer.prototype.sy = function (wy, elev) {
    return (wy - this.cam.y) * this.cam.zoom * TILT + this.h / 2 - (elev || 0) * this.cam.zoom;
  };

  Renderer.prototype.viewBounds = function () {
    var z = this.cam.zoom;
    var halfW = this.w / (2 * z);
    var halfH = this.h / (2 * z * TILT);
    return {
      x0: this.cam.x - halfW - 80, x1: this.cam.x + halfW + 80,
      y0: this.cam.y - halfH - 200, y1: this.cam.y + halfH + 200
    };
  };

  // =====================================================================
  // Sea
  // =====================================================================

  Renderer.prototype._buildWaterPattern = function () {
    var size = 256;
    var pc = document.createElement('canvas');
    pc.width = pc.height = size;
    var p = pc.getContext('2d');
    p.clearRect(0, 0, size, size);

    // Soft interlocking swells.
    for (var i = 0; i < 26; i++) {
      var x = Math.random() * size, y = Math.random() * size;
      var r = rnd(18, 52);
      var g = p.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(255,255,255,0.045)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      p.fillStyle = g;
      p.beginPath(); p.ellipse(x, y, r, r * 0.55, 0, 0, TAU); p.fill();
    }
    for (var j = 0; j < 22; j++) {
      p.strokeStyle = 'rgba(180,225,240,' + rnd(0.03, 0.08).toFixed(3) + ')';
      p.lineWidth = rnd(0.8, 2);
      p.beginPath();
      var sx = Math.random() * size, sy = Math.random() * size, len = rnd(20, 70);
      p.moveTo(sx, sy);
      p.quadraticCurveTo(sx + len * 0.5, sy - rnd(2, 7), sx + len, sy);
      p.stroke();
    }
    this.waterPattern = this.ctx.createPattern(pc, 'repeat');
    this.waterPatternSize = size;
  };

  Renderer.prototype.drawSea = function (state) {
    var ctx = this.ctx;
    var g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, '#0a3a5c');
    g.addColorStop(0.55, '#0c4568');
    g.addColorStop(1, '#093250');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    if (!this.waterPattern) this._buildWaterPattern();

    var wind = state.wind;
    var t = this.time;
    var dx = Math.cos(wind.dir) * wind.strength * 13 * t;
    var dy = Math.sin(wind.dir) * wind.strength * 13 * t * TILT;

    // Two parallax layers of swell, locked to the world so they scroll
    // correctly as the camera moves.
    var layers = [
      { s: 1.0, a: 0.95, mul: 1 },
      { s: 1.85, a: 0.5, mul: -0.45 }
    ];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var z = this.cam.zoom * L.s;
      ctx.save();
      ctx.globalAlpha = L.a;
      var ox = (-this.cam.x * this.cam.zoom + this.w / 2 + dx * L.mul);
      var oy = (-this.cam.y * this.cam.zoom * TILT + this.h / 2 + dy * L.mul);
      ctx.translate(ox, oy);
      ctx.scale(z, z * TILT);
      ctx.fillStyle = this.waterPattern;
      var sz = this.waterPatternSize;
      var vx0 = (-ox) / z, vy0 = (-oy) / (z * TILT);
      ctx.fillRect(vx0 - sz, vy0 - sz, this.w / z + sz * 3, this.h / (z * TILT) + sz * 3);
      ctx.restore();
    }

    this.drawWindField(wind);
  };

  /**
   * The wind has to be readable without looking at the compass, so the water
   * carries it: streaks and arrowheads racing downwind, whitecaps breaking in
   * a fresh breeze, and a wash of gust bands moving over the surface. All of
   * it scales with strength, so a dying breeze visibly goes slack.
   */
  Renderer.prototype.drawWindField = function (wind) {
    var ctx = this.ctx;
    var ca = Math.cos(wind.dir), sa = Math.sin(wind.dir) * TILT;
    var str = wind.strength;
    // Remap 0.4..1.0 onto 0..1 so the weakest breeze still shows something
    // and a strong one is unmistakable.
    var pow = clamp((str - C.WIND_MIN) / (C.WIND_MAX - C.WIND_MIN), 0, 1);
    var vis = 0.35 + 0.65 * pow;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (var i = 0; i < this.streaks.length; i++) {
      var s = this.streaks[i];
      var travel = (this.time * s.sp * (0.35 + str * 1.15) * 0.16) % 1.3;
      var px = ((s.x + ca * travel) % 1 + 1) % 1;
      var py = ((s.y + sa * travel) % 1 + 1) % 1;
      var x = px * this.w, y = py * this.h;
      var fade = Math.sin(((travel / 1.3) % 1) * Math.PI);
      var alpha = s.a * fade * vis;
      if (alpha < 0.012) continue;

      var len = s.len * (0.55 + 0.45 * pow);
      var ex = x + ca * len, ey = y + sa * len;

      if (s.cap && pow > 0.45) {
        // Whitecaps: short bright dashes across the wind, breaking.
        ctx.strokeStyle = 'rgba(255,255,255,' + (alpha * 1.5).toFixed(3) + ')';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(x - sa * 5, y + ca * 5 * TILT);
        ctx.lineTo(x + sa * 5, y - ca * 5 * TILT);
        ctx.stroke();
        continue;
      }

      ctx.strokeStyle = 'rgba(214,242,252,' + alpha.toFixed(3) + ')';
      ctx.lineWidth = 1.6 + 1.4 * pow;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      if (s.arrow) {
        // A small chevron at the head, pointing the way the wind blows.
        var hw = 4 + 3 * pow;
        var bx = ex - ca * hw * 1.7, by = ey - sa * hw * 1.7;
        ctx.strokeStyle = 'rgba(232,250,255,' + (alpha * 1.25).toFixed(3) + ')';
        ctx.lineWidth = 1.8 + 1.2 * pow;
        ctx.beginPath();
        ctx.moveTo(bx - sa * hw, by + ca * hw * TILT);
        ctx.lineTo(ex, ey);
        ctx.lineTo(bx + sa * hw, by - ca * hw * TILT);
        ctx.stroke();
      }
    }

    ctx.restore();
  };

  // =====================================================================
  // Land
  // =====================================================================

  Renderer.prototype.drawTerrain = function () {
    var T = this.terrain;
    if (!T || !T.ready) return;
    var ctx = this.ctx;
    var z = this.cam.zoom;

    // Uniform scale between bake space and screen space.
    var scale = BAKE / z;
    var srcX = (this.cam.x - this.w / (2 * z)) * BAKE;
    var srcY = (this.cam.y - this.h / (2 * z * TILT)) * TILT * BAKE + T.offsetY;
    var srcW = this.w * scale;
    var srcH = this.h * scale;

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // drawImage clamps at the edges, so clip the source to the bake canvas.
    var cx = Math.max(0, srcX), cy = Math.max(0, srcY);
    var cw = Math.min(T.canvas.width, srcX + srcW) - cx;
    var chh = Math.min(T.canvas.height, srcY + srcH) - cy;
    if (cw > 0 && chh > 0) {
      var dx = (cx - srcX) / scale, dy = (cy - srcY) / scale;
      ctx.drawImage(T.canvas, cx, cy, cw, chh, dx, dy, cw / scale, chh / scale);
    }
    ctx.restore();
  };

  /** Everything outside the battle area, washed out and clearly deadly. */
  Renderer.prototype.drawZoneWash = function (state) {
    var z = state.zone;
    if (!z) return;
    var ctx = this.ctx;
    var x0 = this.sx(z[0]), x1 = this.sx(z[2]);
    var y0 = this.sy(z[1], 0), y1 = this.sy(z[3], 0);
    // Nothing to draw if the whole screen is still inside.
    if (x0 <= 0 && y0 <= 0 && x1 >= this.w && y1 >= this.h) return;

    var pulse = 0.5 + 0.5 * Math.sin(this.time * 2.2);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-4000, -4000, this.w + 8000, this.h + 8000);
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.fillStyle = 'rgba(150,18,32,' + (0.26 + 0.07 * pulse).toFixed(3) + ')';
    ctx.fill('evenodd');
    ctx.restore();
  };

  /** The boundary itself, drawn over the ships so it is never lost. */
  Renderer.prototype.drawZoneBorder = function (state) {
    var z = state.zone;
    if (!z) return;
    var ctx = this.ctx;
    var x0 = this.sx(z[0]), x1 = this.sx(z[2]);
    var y0 = this.sy(z[1], 0), y1 = this.sy(z[3], 0);
    if (x0 <= -60 && y0 <= -60 && x1 >= this.w + 60 && y1 >= this.h + 60) return;

    var pulse = 0.5 + 0.5 * Math.sin(this.time * 2.2);
    ctx.save();
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = 'rgba(255,90,110,' + (0.55 + 0.35 * pulse).toFixed(3) + ')';
    ctx.lineWidth = 3 + 2 * pulse;
    ctx.shadowColor = 'rgba(255,60,80,0.9)';
    ctx.shadowBlur = 12;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);

    // A crawling dashed inner line, so the edge reads even when it is still.
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,220,180,0.55)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([16, 14]);
    ctx.lineDashOffset = -(this.time * 26) % 30;
    ctx.strokeRect(x0 + 5, y0 + 5, x1 - x0 - 10, y1 - y0 - 10);
    ctx.restore();
  };

  Renderer.prototype.drawDecor = function () {
    var ctx = this.ctx;
    var b = this.viewBounds();
    var z = this.cam.zoom;
    for (var i = 0; i < this.decor.length; i++) {
      var d = this.decor[i];
      if (d.x < b.x0 || d.x > b.x1 || d.y < b.y0 || d.y > b.y1) continue;
      var x = this.sx(d.x), y = this.sy(d.y, d.e);
      this.drawProp(ctx, d, x, y, z);
    }
  };

  Renderer.prototype.drawProp = function (ctx, d, x, y, z) {
    var s = d.s * z;
    ctx.save();
    ctx.translate(x, y);

    // Ground shadow, squashed by the tilt.
    ctx.fillStyle = 'rgba(20,40,20,0.22)';
    ctx.beginPath();
    ctx.ellipse(2 * z, 1.5 * z, 7 * s, 3.4 * s, 0, 0, TAU);
    ctx.fill();

    switch (d.k) {
      case 'tree':
        ctx.fillStyle = '#5a3d22';
        ctx.fillRect(-1.2 * s, -6 * s, 2.4 * s, 7 * s);
        ctx.fillStyle = '#2f6b32';
        ctx.beginPath(); ctx.ellipse(0, -10 * s, 7.5 * s, 7 * s, 0, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(120,190,110,0.5)';
        ctx.beginPath(); ctx.ellipse(-2 * s, -12 * s, 4 * s, 3.4 * s, 0, 0, TAU); ctx.fill();
        break;

      case 'pine':
        ctx.fillStyle = '#4a3218';
        ctx.fillRect(-1.1 * s, -5 * s, 2.2 * s, 6 * s);
        ctx.fillStyle = '#1f5630';
        for (var k = 0; k < 3; k++) {
          var yy = -5 * s - k * 4.6 * s, ww = (7.5 - k * 1.9) * s;
          ctx.beginPath();
          ctx.moveTo(0, yy - 7 * s); ctx.lineTo(ww, yy); ctx.lineTo(-ww, yy);
          ctx.closePath(); ctx.fill();
        }
        break;

      case 'palm':
        ctx.strokeStyle = '#6b4a28'; ctx.lineWidth = 2 * s; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(2 * s, -7 * s, 4 * s, -13 * s); ctx.stroke();
        ctx.fillStyle = '#3f8f45';
        for (var f = 0; f < 6; f++) {
          var fa = (f / 6) * TAU + d.r;
          ctx.save(); ctx.translate(4 * s, -13 * s); ctx.rotate(fa);
          ctx.beginPath(); ctx.ellipse(6 * s, 0, 6.5 * s, 2 * s, 0, 0, TAU); ctx.fill();
          ctx.restore();
        }
        break;

      case 'house':
        ctx.fillStyle = '#e8ddc4';
        ctx.fillRect(-7 * s, -9 * s, 14 * s, 10 * s);
        ctx.fillStyle = '#c9391f';
        ctx.beginPath();
        ctx.moveTo(-8.5 * s, -9 * s); ctx.lineTo(0, -16 * s); ctx.lineTo(8.5 * s, -9 * s);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(60,40,20,0.75)';
        ctx.fillRect(-2 * s, -5 * s, 4 * s, 6 * s);
        break;

      case 'windmill':
        ctx.fillStyle = '#ded3b8';
        ctx.beginPath();
        ctx.moveTo(-6 * s, 1 * s); ctx.lineTo(-4 * s, -14 * s);
        ctx.lineTo(4 * s, -14 * s); ctx.lineTo(6 * s, 1 * s);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#7a4a2a';
        ctx.beginPath(); ctx.moveTo(-5 * s, -14 * s); ctx.lineTo(0, -19 * s); ctx.lineTo(5 * s, -14 * s); ctx.closePath(); ctx.fill();
        ctx.save();
        ctx.translate(0, -14 * s);
        ctx.rotate(this.time * 1.1 + d.r);
        ctx.strokeStyle = '#8c6239'; ctx.lineWidth = 1.6 * s;
        for (var b2 = 0; b2 < 4; b2++) {
          ctx.rotate(Math.PI / 2);
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(9 * s, 0); ctx.stroke();
          ctx.fillStyle = 'rgba(245,240,225,0.85)';
          ctx.fillRect(3 * s, -2.2 * s, 6 * s, 2.2 * s);
        }
        ctx.restore();
        break;

      case 'lighthouse':
        ctx.fillStyle = '#f2ead6';
        ctx.beginPath();
        ctx.moveTo(-5 * s, 1 * s); ctx.lineTo(-3.2 * s, -20 * s);
        ctx.lineTo(3.2 * s, -20 * s); ctx.lineTo(5 * s, 1 * s);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#c9391f';
        ctx.fillRect(-4.3 * s, -9 * s, 8.6 * s, 3.4 * s);
        ctx.fillRect(-3.6 * s, -16 * s, 7.2 * s, 3 * s);
        var beam = 0.45 + 0.55 * Math.abs(Math.sin(this.time * 0.9 + d.r));
        ctx.fillStyle = 'rgba(255,238,170,' + beam.toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(0, -22 * s, 3.2 * s, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,180,' + (0.12 * beam).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(0, -22 * s, 12 * s, 0, TAU); ctx.fill();
        break;

      case 'tower':
        ctx.fillStyle = '#9a9384';
        ctx.fillRect(-5 * s, -17 * s, 10 * s, 18 * s);
        ctx.fillStyle = '#7d7466';
        for (var m = 0; m < 3; m++) ctx.fillRect((-5 + m * 3.6) * s, -20 * s, 2.4 * s, 3.2 * s);
        break;

      case 'dock':
        ctx.fillStyle = '#7d5731';
        ctx.fillRect(-9 * s, -2 * s, 18 * s, 5 * s);
        ctx.fillStyle = '#5c3f22';
        for (var pl = 0; pl < 4; pl++) ctx.fillRect((-8 + pl * 4.4) * s, 3 * s, 1.6 * s, 3 * s);
        break;

      case 'rock':
        ctx.fillStyle = '#8c8578';
        ctx.beginPath();
        ctx.moveTo(-6 * s, 1 * s); ctx.lineTo(-3 * s, -7 * s); ctx.lineTo(2 * s, -9 * s);
        ctx.lineTo(6 * s, -2 * s); ctx.lineTo(4 * s, 1 * s);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,250,0.22)';
        ctx.beginPath();
        ctx.moveTo(-3 * s, -7 * s); ctx.lineTo(2 * s, -9 * s); ctx.lineTo(1 * s, -5 * s);
        ctx.closePath(); ctx.fill();
        break;
    }
    ctx.restore();
  };

  // =====================================================================
  // Whirlpools
  // =====================================================================

  Renderer.prototype.drawWhirlpools = function (state) {
    var ctx = this.ctx;
    for (var i = 0; i < state.whirlpools.length; i++) {
      var w = state.whirlpools[i];
      var x = this.sx(w.x), y = this.sy(w.y, 0);
      var r = w.r * this.cam.zoom;
      var fade = w.fade === undefined ? 1 : w.fade;

      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, TILT);
      ctx.globalAlpha = fade;

      var g = ctx.createRadialGradient(0, 0, r * 0.05, 0, 0, r);
      g.addColorStop(0, 'rgba(2,14,26,0.92)');
      g.addColorStop(0.34, 'rgba(8,42,66,0.6)');
      g.addColorStop(0.75, 'rgba(24,86,122,0.24)');
      g.addColorStop(1, 'rgba(30,110,150,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();

      ctx.lineCap = 'round';
      for (var arm = 0; arm < 5; arm++) {
        ctx.strokeStyle = 'rgba(210,240,250,' + (0.30 - arm * 0.04).toFixed(2) + ')';
        ctx.lineWidth = Math.max(1, (3.2 - arm * 0.45) * this.cam.zoom);
        ctx.beginPath();
        var a0 = w.phase * 2.1 + (arm / 5) * TAU;
        for (var t = 0; t <= 1.001; t += 0.06) {
          var rr = r * (0.10 + 0.88 * t);
          var aa = a0 + t * 4.4;
          var px = Math.cos(aa) * rr, py = Math.sin(aa) * rr;
          if (t === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.11, 0, TAU); ctx.fill();
      ctx.restore();
    }
  };

  // =====================================================================
  // Power-ups
  // =====================================================================

  var PU_NAME = {
    sail: 'Larger Sail',
    cannon: 'Extra Cannon',
    super: 'Super Shot',
    rapid: 'Rapid Fire',
    repair_s: 'Repairs +' + C.REPAIR_S_AMOUNT,
    repair_l: 'Repairs +' + C.REPAIR_L_AMOUNT
  };

  var PU_LOOK = {
    sail: { col: '#f2ead6', ring: '#ffffff' },
    cannon: { col: '#3a3a42', ring: '#9aa0aa' },
    super: { col: '#e6394d', ring: '#ff8fa3' },
    rapid: { col: '#f4a259', ring: '#ffc489' },
    repair_s: { col: '#64c98a', ring: '#9bde7e' },
    repair_l: { col: '#39b06a', ring: '#9bde7e' }
  };

  Renderer.prototype.drawPowerups = function (state) {
    var ctx = this.ctx;
    for (var i = 0; i < state.powerups.length; i++) {
      var p = state.powerups[i];
      var bob = Math.sin(this.time * 2.4 + p.id * 0.7) * 2.4;
      var x = this.sx(p.x), y = this.sy(p.y, 0) + bob;
      var z = this.cam.zoom;
      var look = PU_LOOK[p.type] || PU_LOOK.cannon;

      ctx.save();
      ctx.translate(x, y);

      ctx.fillStyle = 'rgba(0,20,34,0.34)';
      ctx.beginPath(); ctx.ellipse(1 * z, (7 - bob) * z * TILT, 11 * z, 5 * z * TILT, 0, 0, TAU); ctx.fill();

      // Floating crate
      ctx.save();
      ctx.scale(1, TILT * 1.18);
      ctx.rotate(Math.sin(this.time * 1.5 + p.id) * 0.1);
      ctx.fillStyle = '#7d5731';
      ctx.fillRect(-10 * z, -10 * z, 20 * z, 20 * z);
      ctx.strokeStyle = '#a8763f'; ctx.lineWidth = 1.8 * z;
      ctx.strokeRect(-10 * z, -10 * z, 20 * z, 20 * z);
      ctx.beginPath();
      ctx.moveTo(-10 * z, -10 * z); ctx.lineTo(10 * z, 10 * z);
      ctx.moveTo(10 * z, -10 * z); ctx.lineTo(-10 * z, 10 * z);
      ctx.stroke();
      ctx.restore();

      // Emblem sitting proud of the crate
      ctx.save();
      ctx.translate(0, -12 * z);
      var pulse = 1 + Math.sin(this.time * 3 + p.id) * 0.07;
      ctx.scale(pulse, pulse);
      ctx.shadowColor = look.ring;
      ctx.shadowBlur = 10 * z;
      this.drawPowerupIcon(ctx, p.type, z, look);
      ctx.restore();

      ctx.restore();
    }
  };

  Renderer.prototype.drawPowerupIcon = function (ctx, type, z, look) {
    ctx.fillStyle = look.col;
    ctx.strokeStyle = look.col;
    switch (type) {
      case 'sail':
        ctx.beginPath();
        ctx.moveTo(0, -9 * z); ctx.quadraticCurveTo(9 * z, -1 * z, 5 * z, 8 * z);
        ctx.lineTo(-5 * z, 8 * z); ctx.quadraticCurveTo(-8 * z, -1 * z, 0, -9 * z);
        ctx.closePath(); ctx.fill();
        break;
      case 'cannon':
        ctx.lineWidth = 5.5 * z; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-6 * z, 3 * z); ctx.lineTo(7 * z, -4 * z); ctx.stroke();
        ctx.fillStyle = '#12141a';
        ctx.beginPath(); ctx.arc(-7 * z, 4 * z, 4 * z, 0, TAU); ctx.fill();
        break;
      case 'super':
        ctx.beginPath();
        for (var i = 0; i < 10; i++) {
          var a = -Math.PI / 2 + (i / 10) * TAU;
          var r = (i % 2 === 0 ? 9.5 : 4.2) * z;
          var px = Math.cos(a) * r, py = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.fill();
        break;
      case 'rapid':
        // Three chevrons: speed.
        ctx.lineWidth = 2.6 * z;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (var c3 = 0; c3 < 3; c3++) {
          var cx3 = (-6 + c3 * 5.5) * z;
          ctx.beginPath();
          ctx.moveTo(cx3 - 2.6 * z, -6 * z);
          ctx.lineTo(cx3 + 2.6 * z, 0);
          ctx.lineTo(cx3 - 2.6 * z, 6 * z);
          ctx.stroke();
        }
        break;
      case 'repair_s':
      case 'repair_l':
        var t = type === 'repair_l' ? 1.32 : 0.92;
        ctx.fillRect(-2.6 * z * t, -8 * z * t, 5.2 * z * t, 16 * z * t);
        ctx.fillRect(-8 * z * t, -2.6 * z * t, 16 * z * t, 5.2 * z * t);
        break;
    }
  };

  // =====================================================================
  // Seagulls
  // =====================================================================

  /**
   * Purely ambient, and purely client side - the gulls are not part of the
   * simulation, so they cost the server nothing and need not agree between
   * players. A flock drifts in from off screen every half minute or so,
   * crosses, and is forgotten once it is well clear.
   */
  Renderer.prototype.updateGulls = function (dt, state) {
    if (this.time >= this.nextGullAt && this.gulls.length < 16) {
      this.nextGullAt = this.time + rnd(22, 48);
      this.spawnFlock(state);
    }

    var out = [];
    for (var i = 0; i < this.gulls.length; i++) {
      var g = this.gulls[i];
      g.t += dt;
      g.x += Math.cos(g.dir) * g.sp * dt;
      g.y += Math.sin(g.dir) * g.sp * dt;
      g.dir += Math.sin(g.t * 0.5 + g.seed) * 0.16 * dt;
      g.flap += dt * g.flapRate;
      // Long slow rise and fall, and the odd glide.
      g.z = g.baseZ + Math.sin(g.t * 0.55 + g.seed) * 14;
      g.gliding = Math.sin(g.t * 0.9 + g.seed * 2) > 0.45;

      var d = Math.hypot(g.x - this.cam.x, g.y - this.cam.y);
      if (d < 2600 && g.t < 90) out.push(g);
    }
    this.gulls = out;
  };

  Renderer.prototype.spawnFlock = function (state) {
    // Come in from a random bearing, roughly downwind, and cross the view.
    var wind = state && state.wind ? state.wind.dir : Math.random() * TAU;
    var dir = wind + rnd(-1.1, 1.1);
    var from = dir + Math.PI;
    var dist = rnd(900, 1300);
    var ox = this.cam.x + Math.cos(from) * dist;
    var oy = this.cam.y + Math.sin(from) * dist;
    // Usually a small group; now and then a single bird on its own.
    var n = Math.random() < 0.2 ? 1 : 2 + Math.floor(Math.random() * 4);
    var sp = rnd(58, 96);

    for (var i = 0; i < n; i++) {
      this.gulls.push({
        x: ox + rnd(-90, 90), y: oy + rnd(-70, 70),
        dir: dir + rnd(-0.12, 0.12),
        sp: sp * rnd(0.9, 1.1),
        baseZ: rnd(70, 145),
        z: 0, t: rnd(0, 2),
        flap: Math.random() * TAU,
        flapRate: rnd(5.5, 8.5),
        scale: rnd(0.85, 1.25),
        seed: Math.random() * 6.28,
        gliding: false
      });
    }
    if (this.onFlock) this.onFlock(ox, oy);
  };

  Renderer.prototype.drawGulls = function () {
    var ctx = this.ctx;
    var z = this.cam.zoom;
    var b = this.viewBounds();

    for (var i = 0; i < this.gulls.length; i++) {
      var g = this.gulls[i];
      if (g.x < b.x0 - 200 || g.x > b.x1 + 200 || g.y < b.y0 - 300 || g.y > b.y1 + 300) continue;

      var sx = this.sx(g.x);
      var groundY = this.sy(g.y, 0);
      var sy = groundY - g.z * z;
      var sc = g.scale * z;

      // Shadow on the water, further off and fainter the higher she is.
      var hi = clamp(g.z / 150, 0, 1);
      ctx.fillStyle = 'rgba(4,26,42,' + (0.20 * (1 - hi * 0.55)).toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(sx + 5 * z, groundY, 5.5 * sc, 2.2 * sc, 0, 0, TAU);
      ctx.fill();

      // Wings: a shallow "m" that flattens out into a glide.
      var beat = g.gliding ? 0.12 : Math.sin(g.flap);
      var span = 9 * sc;
      var lift = beat * 5.2 * sc;

      ctx.strokeStyle = 'rgba(250,250,252,0.95)';
      ctx.lineWidth = Math.max(1.1, 1.9 * sc);
      ctx.lineCap = 'round';
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(Math.sin(g.dir) * 0.25);      // bank slightly with heading
      ctx.beginPath();
      ctx.moveTo(-span, -lift * 0.45);
      ctx.quadraticCurveTo(-span * 0.45, -lift, 0, 0);
      ctx.quadraticCurveTo(span * 0.45, -lift, span, -lift * 0.45);
      ctx.stroke();

      // Body and a dark wingtip hint.
      ctx.fillStyle = 'rgba(248,248,250,0.95)';
      ctx.beginPath();
      ctx.ellipse(0, 0.6 * sc, 2.6 * sc, 1.5 * sc, 0, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = 'rgba(70,80,92,0.7)';
      ctx.lineWidth = Math.max(1, 1.5 * sc);
      ctx.beginPath();
      ctx.moveTo(-span, -lift * 0.45);
      ctx.lineTo(-span * 0.7, -lift * 0.62);
      ctx.moveTo(span, -lift * 0.45);
      ctx.lineTo(span * 0.7, -lift * 0.62);
      ctx.stroke();
      ctx.restore();
    }
  };

  // =====================================================================
  // Wakes
  // =====================================================================

  var TRAIL_LIFE = 5.5;        // seconds before the water closes over it
  var TRAIL_STEP = 7;          // world units between recorded points

  /** Record where every ship has been, so we can draw the water it disturbed. */
  Renderer.prototype.updateTrails = function (state) {
    var seen = {};
    for (var i = 0; i < state.ships.length; i++) {
      var s = state.ships[i];
      seen[s.id] = true;
      var tr = this.trails[s.id];
      if (!tr) tr = this.trails[s.id] = [];

      if (!s.alive) continue;
      var last = tr[tr.length - 1];
      if (last) {
        var d = Math.hypot(s.x - last.x, s.y - last.y);
        // A respawn teleports the ship; never draw a wake across the map.
        if (d > 260) { tr.length = 0; last = null; }
        else if (d < TRAIL_STEP) continue;
      }
      tr.push({ x: s.x, y: s.y, a: s.angle, t: this.time, sp: s.speed });
      if (tr.length > 140) tr.shift();
    }

    // Age points out, and forget ships that have left the game.
    for (var id in this.trails) {
      var list = this.trails[id];
      while (list.length && this.time - list[0].t > TRAIL_LIFE) list.shift();
      if (!seen[id] && !list.length) delete this.trails[id];
    }
  };

  Renderer.prototype.drawTrails = function (state) {
    var ctx = this.ctx;
    var z = this.cam.zoom;
    var colours = {};
    for (var i = 0; i < state.ships.length; i++) colours[state.ships[i].id] = state.ships[i];

    for (var id in this.trails) {
      var pts = this.trails[id];
      if (pts.length < 2) continue;

      // Two foam edges spreading out behind her, and a calmer band between.
      for (var side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        for (var i2 = 0; i2 < pts.length; i2++) {
          var p = pts[i2];
          var age = (this.time - p.t) / TRAIL_LIFE;
          var spread = (C.SHIP_HALF_BEAM * 0.8 + age * 26) * side;
          var px = p.x + Math.cos(p.a + Math.PI / 2) * spread;
          var py = p.y + Math.sin(p.a + Math.PI / 2) * spread;
          var sx = this.sx(px), sy = this.sy(py, 0);
          if (i2 === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
        }
        ctx.strokeStyle = 'rgba(226,245,252,0.20)';
        ctx.lineWidth = Math.max(1, 2.2 * z);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
      }

      // The churned water itself, fading as it settles.
      for (var i3 = 1; i3 < pts.length; i3++) {
        var a = pts[i3 - 1], b = pts[i3];
        var age2 = (this.time - b.t) / TRAIL_LIFE;
        if (age2 > 1) continue;
        var fade = (1 - age2) * (1 - age2);
        var speedFrac = clamp((b.sp || 0) / C.BASE_SPEED, 0, 1);
        ctx.strokeStyle = 'rgba(214,240,250,' + (0.20 * fade * (0.35 + 0.65 * speedFrac)).toFixed(3) + ')';
        ctx.lineWidth = Math.max(1, (C.SHIP_BEAM * 0.75 + age2 * 34) * z);
        ctx.beginPath();
        ctx.moveTo(this.sx(a.x), this.sy(a.y, 0));
        ctx.lineTo(this.sx(b.x), this.sy(b.y, 0));
        ctx.stroke();
      }
    }
  };

  // =====================================================================
  // Ships
  // =====================================================================

  Renderer.prototype.drawShips = function (state) {
    // A sunk ship has already blown up and left a wreck; she must not go on
    // being drawn as an intact hull while she waits to respawn.
    var list = state.ships.filter(function (s) { return s.alive; });
    list.sort(function (a, b) { return a.y - b.y; });
    for (var i = 0; i < list.length; i++) this.drawShip(state, list[i]);
  };

  Renderer.prototype.drawShip = function (state, s) {
    var ctx = this.ctx;
    var z = this.cam.zoom;
    var x = this.sx(s.x), y = this.sy(s.y, 0);
    var col = s.color;
    var bob = Math.sin(this.time * 1.7 + s.id * 1.3) * 1.1 * z;

    // Hull shadow
    ctx.save();
    ctx.translate(x + 3 * z, y + 4 * z * TILT);
    ctx.scale(z, z * TILT);
    ctx.rotate(s.angle);
    ctx.fillStyle = 'rgba(2,18,30,0.30)';
    this.hullPath(ctx);
    ctx.fill();
    ctx.restore();

    // ---- hull, flat on the water ----
    ctx.save();
    ctx.translate(x, y + bob);
    ctx.scale(z, z * TILT);
    ctx.rotate(s.angle);

    if (s.protect) {
      ctx.save();
      ctx.globalAlpha = 0.28 + 0.14 * Math.sin(this.time * 6);
      ctx.fillStyle = '#7bdff2';
      ctx.beginPath(); ctx.ellipse(0, 0, C.SHIP_HALF_LEN + 9, C.SHIP_HALF_BEAM + 11, 0, 0, TAU); ctx.fill();
      ctx.restore();
    }

    // Shot heating in the furnace: she carries a red glow while loaded with
    // super shot, so everyone nearby can see what is coming.
    if (s.superTime > 0) {
      var pulse = 0.72 + 0.28 * Math.sin(this.time * 5.5 + s.id);
      var halo = ctx.createRadialGradient(0, 0, C.SHIP_HALF_BEAM * 0.6, 0, 0, C.SHIP_HALF_LEN + 26);
      halo.addColorStop(0, 'rgba(255,150,70,' + (0.50 * pulse).toFixed(3) + ')');
      halo.addColorStop(0.45, 'rgba(255,96,48,' + (0.26 * pulse).toFixed(3) + ')');
      halo.addColorStop(1, 'rgba(255,70,40,0)');
      ctx.save();
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.ellipse(0, 0, C.SHIP_HALF_LEN + 26, C.SHIP_HALF_BEAM + 24, 0, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // Planking
    ctx.fillStyle = '#8a5a33';
    this.hullPath(ctx);
    ctx.fill();
    ctx.strokeStyle = '#4e3018';
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Inner deck
    ctx.fillStyle = '#b98a54';
    ctx.beginPath();
    ctx.ellipse(-1, 0, C.SHIP_HALF_LEN - 6, C.SHIP_HALF_BEAM - 3.4, 0, 0, TAU);
    ctx.fill();

    ctx.strokeStyle = 'rgba(80,50,24,0.45)';
    ctx.lineWidth = 0.8;
    for (var pl = -2; pl <= 2; pl++) {
      ctx.beginPath();
      ctx.moveTo(-C.SHIP_HALF_LEN + 8, pl * 3.6);
      ctx.lineTo(C.SHIP_HALF_LEN - 9, pl * 3.6);
      ctx.stroke();
    }

    // Team / player stripe along the gunwale
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.6;
    this.hullPath(ctx, -1.4);
    ctx.stroke();

    // Gun ports: the firing side glows brass
    this.drawGunPorts(ctx, s);

    // Stern lantern
    ctx.fillStyle = 'rgba(255,214,140,0.9)';
    ctx.beginPath(); ctx.arc(-C.SHIP_HALF_LEN + 3, 0, 1.8, 0, TAU); ctx.fill();

    ctx.restore();

    // ---- bow wave & wake ----
    if (s.speed > 18) this.drawBowWave(s, x, y + bob, z);
    if (s.boosting) this.drawBoostWash(s, x, y + bob, z);

    // ---- masts and sails, standing upright ----
    this.drawRig(state, s, x, y + bob, z, col);

    // ---- name plate ----
    if (this.showNames) this.drawNamePlate(state, s, x, y + bob, z, col);
  };

  Renderer.prototype.hullPath = function (ctx, inset) {
    var L = C.SHIP_HALF_LEN + (inset || 0);
    var B = C.SHIP_HALF_BEAM + (inset || 0);
    ctx.beginPath();
    ctx.moveTo(L, 0);                                   // bow point
    ctx.bezierCurveTo(L * 0.55, -B, -L * 0.35, -B, -L * 0.86, -B * 0.62);
    ctx.quadraticCurveTo(-L, -B * 0.3, -L, 0);          // transom
    ctx.quadraticCurveTo(-L, B * 0.3, -L * 0.86, B * 0.62);
    ctx.bezierCurveTo(-L * 0.35, B, L * 0.55, B, L, 0);
    ctx.closePath();
  };

  /**
   * Which side the guns are on has to be readable at a glance in a melee, so
   * the firing side gets a lit gun deck, run-out barrels, a bright rail and
   * chevrons pointing the way the broadside will go. It brightens further
   * once the guns are actually loaded.
   */
  Renderer.prototype.drawGunPorts = function (ctx, s) {
    var n = s.cannons;
    var ready = s.reload >= 1;
    var L = C.SHIP_HALF_LEN, B = C.SHIP_HALF_BEAM;
    var glow = ready ? 1 : 0.45;

    // Lit strip along the firing side.
    var band = ctx.createLinearGradient(0, s.side * B * 0.2, 0, s.side * (B + 7));
    band.addColorStop(0, 'rgba(255,206,110,' + (0.50 * glow).toFixed(3) + ')');
    band.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = band;
    ctx.beginPath();
    ctx.moveTo(L * 0.72, s.side * B * 0.55);
    ctx.lineTo(-L * 0.86, s.side * B * 0.55);
    ctx.lineTo(-L * 0.80, s.side * (B + 8));
    ctx.lineTo(L * 0.66, s.side * (B + 8));
    ctx.closePath();
    ctx.fill();

    // Bright rail right along the firing gunwale.
    ctx.strokeStyle = ready ? '#ffd98a' : 'rgba(240,196,106,0.65)';
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(L * 0.70, s.side * (B - 0.6));
    ctx.quadraticCurveTo(0, s.side * (B + 1.6), -L * 0.84, s.side * (B - 1.2));
    ctx.stroke();

    // Gun ports, both sides; the idle side stays shut and dark.
    for (var side = -1; side <= 1; side += 2) {
      var active = side === s.side;
      for (var i = 0; i < n; i++) {
        var t = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        var along = t * (L - 11);
        var across = side * (B - 1.8);
        if (active) {
          ctx.fillStyle = ready ? '#ffe6ad' : '#c9922f';
          ctx.fillRect(along - 2.6, across - 2.1, 5.2, 4.2);
          ctx.fillStyle = '#15151a';                       // barrel run out
          ctx.fillRect(along - 1.4, across + side * 0.8, 2.8, side * 6.2);
        } else {
          ctx.fillStyle = '#2a1c0e';
          ctx.fillRect(along - 2, across - 1.5, 4, 3);
        }
      }
    }

    // Chevrons outboard, pointing where the broadside goes.
    ctx.strokeStyle = ready ? 'rgba(255,224,150,0.95)' : 'rgba(255,214,130,0.42)';
    ctx.lineWidth = 1.9;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (var c = 0; c < 3; c++) {
      var ax = (c - 1) * L * 0.42;
      var ay = s.side * (B + 8 + c * 0);
      ctx.beginPath();
      ctx.moveTo(ax - 4.5, ay);
      ctx.lineTo(ax, ay + s.side * 4.6);
      ctx.lineTo(ax + 4.5, ay);
      ctx.stroke();
    }
  };

  Renderer.prototype.drawBowWave = function (s, x, y, z) {
    var ctx = this.ctx;
    var frac = clamp(s.speed / C.BASE_SPEED, 0, 1.4);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(z, z * TILT);
    ctx.rotate(s.angle);
    ctx.globalAlpha = 0.28 + 0.34 * frac;
    ctx.fillStyle = '#dff2fa';
    var w = 6 + 9 * frac;
    ctx.beginPath();
    ctx.moveTo(C.SHIP_HALF_LEN - 1, 0);
    ctx.quadraticCurveTo(C.SHIP_HALF_LEN + w * 0.8, -w * 0.55, C.SHIP_HALF_LEN + w * 0.2, -w);
    ctx.quadraticCurveTo(C.SHIP_HALF_LEN - 4, -w * 0.4, C.SHIP_HALF_LEN - 1, 0);
    ctx.moveTo(C.SHIP_HALF_LEN - 1, 0);
    ctx.quadraticCurveTo(C.SHIP_HALF_LEN + w * 0.8, w * 0.55, C.SHIP_HALF_LEN + w * 0.2, w);
    ctx.quadraticCurveTo(C.SHIP_HALF_LEN - 4, w * 0.4, C.SHIP_HALF_LEN - 1, 0);
    ctx.fill();
    ctx.restore();
  };

  /** White water thrown astern while the boost is engaged. */
  Renderer.prototype.drawBoostWash = function (s, x, y, z) {
    var ctx = this.ctx;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(z, z * TILT);
    ctx.rotate(s.angle);
    var surge = 0.7 + 0.3 * Math.sin(this.time * 22 + s.id);
    var len = C.SHIP_HALF_LEN * (2.1 + 0.8 * surge);
    var g = ctx.createLinearGradient(-C.SHIP_HALF_LEN, 0, -C.SHIP_HALF_LEN - len, 0);
    g.addColorStop(0, 'rgba(240,252,255,' + (0.78 * surge).toFixed(3) + ')');
    g.addColorStop(0.5, 'rgba(190,232,246,0.26)');
    g.addColorStop(1, 'rgba(180,225,240,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-C.SHIP_HALF_LEN + 3, -C.SHIP_HALF_BEAM * 0.85);
    ctx.quadraticCurveTo(-C.SHIP_HALF_LEN - len * 0.5, -C.SHIP_HALF_BEAM * 1.7,
      -C.SHIP_HALF_LEN - len, 0);
    ctx.quadraticCurveTo(-C.SHIP_HALF_LEN - len * 0.5, C.SHIP_HALF_BEAM * 1.7,
      -C.SHIP_HALF_LEN + 3, C.SHIP_HALF_BEAM * 0.85);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (Math.random() < 0.85) {
      var bx = s.x - Math.cos(s.angle) * (C.SHIP_HALF_LEN + 6);
      var by = s.y - Math.sin(s.angle) * (C.SHIP_HALF_LEN + 6);
      this.particles.burst('splash', bx + rnd(-6, 6), by + rnd(-6, 6));
    }
  };

  /**
   * Masts, yards and sails drawn upright. The yards are braced square to the
   * wind, so the sails themselves show you where the wind is coming from.
   */
  Renderer.prototype.drawRig = function (state, s, x, y, z, col) {
    var ctx = this.ctx;
    var wind = state.wind;
    var yardAngle = wind.dir + Math.PI / 2;
    var ca = Math.cos(yardAngle), sa = Math.sin(yardAngle) * TILT;

    // How square the wind is behind us decides how full the canvas draws.
    var fill = 0.35 + 0.65 * Math.max(0, (Math.cos(s.angle - wind.dir) + 1) / 2);
    fill *= 0.55 + 0.45 * wind.strength;

    /* Rig progression: she starts under two small sails. The first sail
     * power-up steps her up to three; each one after that lets out more
     * canvas on all of them. */
    var stacks = s.sails || 0;
    var masts = stacks >= 1
      ? [{ along: 12, h: 30, w: 15 }, { along: -3, h: 36, w: 18 }, { along: -17, h: 26, w: 13 }]
      : [{ along: 8, h: 29, w: 14 }, { along: -11, h: 33, w: 16 }];

    // Stack 0 and 1 are the small suit of sails; 2 and 3 grow it.
    var suit = 0.80 + 0.17 * Math.max(0, stacks - 1);

    for (var i = 0; i < masts.length; i++) {
      var m = masts[i];
      var mx = s.x + Math.cos(s.angle) * m.along;
      var my = s.y + Math.sin(s.angle) * m.along;
      var px = this.sx(mx), py = this.sy(my, 0) + (y - this.sy(s.y, 0));

      var mh = m.h * z * (0.94 + 0.06 * suit);
      var hw = m.w * z * suit;

      // Mast
      ctx.strokeStyle = '#6b4526';
      ctx.lineWidth = 2.2 * z;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px, py - mh);
      ctx.stroke();

      // Yard
      var yx = ca * hw, yy = sa * hw;
      var topY = py - mh * 0.92;
      ctx.strokeStyle = '#7d5731';
      ctx.lineWidth = 1.6 * z;
      ctx.beginPath();
      ctx.moveTo(px - yx, topY - yy);
      ctx.lineTo(px + yx, topY + yy);
      ctx.stroke();

      // Sail: a quad from the yard down, bellied out downwind
      var sailH = mh * 0.55 * suit;
      var belly = fill * 7 * z;
      var bx = Math.cos(wind.dir) * belly, by = Math.sin(wind.dir) * belly * TILT;

      var grad = ctx.createLinearGradient(px - yx, topY - yy, px + yx, topY + yy);
      grad.addColorStop(0, 'rgba(226,218,196,0.97)');
      grad.addColorStop(0.5, 'rgba(248,244,232,0.97)');
      grad.addColorStop(1, 'rgba(214,205,182,0.97)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(px - yx, topY - yy);
      ctx.lineTo(px + yx, topY + yy);
      ctx.quadraticCurveTo(px + yx + bx, topY + yy + sailH * 0.55 + by, px + yx * 0.86 + bx, topY + yy + sailH);
      ctx.lineTo(px - yx * 0.86 + bx, topY - yy + sailH);
      ctx.quadraticCurveTo(px - yx + bx, topY - yy + sailH * 0.55 + by, px - yx, topY - yy);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,100,70,0.5)';
      ctx.lineWidth = 0.9 * z;
      ctx.stroke();

      // A green cast on the canvas while she is carrying extra sail.
      if (stacks > 0) {
        ctx.fillStyle = 'rgba(155,222,126,' + (0.07 * stacks).toFixed(3) + ')';
        ctx.fill();
      }
    }

    // Ensign at the stern, streaming downwind
    var fx = s.x + Math.cos(s.angle) * -(C.SHIP_HALF_LEN - 2);
    var fy = s.y + Math.sin(s.angle) * -(C.SHIP_HALF_LEN - 2);
    var px2 = this.sx(fx), py2 = this.sy(fy, 0) + (y - this.sy(s.y, 0));
    var fh = 22 * z;
    ctx.strokeStyle = '#6b4526'; ctx.lineWidth = 1.6 * z;
    ctx.beginPath(); ctx.moveTo(px2, py2); ctx.lineTo(px2, py2 - fh); ctx.stroke();

    var flagLen = 11 * z * (0.5 + 0.5 * wind.strength);
    var wave = Math.sin(this.time * 6 + s.id) * 2 * z;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(px2, py2 - fh);
    ctx.lineTo(px2 + Math.cos(wind.dir) * flagLen, py2 - fh + Math.sin(wind.dir) * flagLen * TILT + wave);
    ctx.lineTo(px2 + Math.cos(wind.dir) * flagLen * 0.9, py2 - fh + Math.sin(wind.dir) * flagLen * TILT + 6 * z + wave);
    ctx.lineTo(px2, py2 - fh + 6 * z);
    ctx.closePath();
    ctx.fill();
  };

  Renderer.prototype.drawNamePlate = function (state, s, x, y, z, col) {
    var ctx = this.ctx;
    var top = y - 52 * z;
    var w = 46 * z;
    var isMe = s.id === state.meId;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = (isMe ? 'bold ' : '') + Math.max(10, Math.round(12 * z)) + 'px "Trebuchet MS", sans-serif';

    var label = s.name + (s.isBot ? ' ⚙' : '');
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,10,18,0.85)';
    ctx.strokeText(label, x, top - 5 * z);
    ctx.fillStyle = isMe ? '#ffe9a8' : '#f2ead6';
    ctx.fillText(label, x, top - 5 * z);

    // Health bar
    var bh = Math.max(4, 5 * z);
    ctx.fillStyle = 'rgba(0,12,20,0.72)';
    ctx.fillRect(x - w / 2 - 1, top - 1, w + 2, bh + 2);
    var frac = clamp(s.hp / C.SHIP_HP, 0, 1);
    ctx.fillStyle = frac > 0.55 ? '#64c98a' : (frac > 0.25 ? '#e0a53c' : '#e6394d');
    ctx.fillRect(x - w / 2, top, w * frac, bh);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - w / 2 - 1.5, top - 1.5, w + 3, bh + 3);
    ctx.restore();
  };

  // =====================================================================
  // Projectiles, wrecks, particles
  // =====================================================================

  Renderer.prototype.drawProjectiles = function (state) {
    var ctx = this.ctx;
    var z = this.cam.zoom;

    for (var i = 0; i < state.projectiles.length; i++) {
      var p = state.projectiles[i];
      // Loft the ball along its flight so it visibly arcs over low land.
      var prog = clamp(p.prog, 0, 1);
      var arc = Math.sin(prog * Math.PI) * 30;
      var x = this.sx(p.x);
      var yGround = this.sy(p.y, 0);
      var y = yGround - arc * z;
      var r = Math.max(2.8, 4.8 * z);

      // Direction of travel, for the trail.
      var sp = Math.hypot(p.vx || 0, p.vy || 0) || 1;
      var ux = (p.vx || 0) / sp, uy = (p.vy || 0) / sp;
      var tail = 30 * z;

      // Shadow on the water, so the height of the shot reads clearly.
      var shadowFade = 0.34 * (1 - 0.45 * Math.sin(prog * Math.PI));
      ctx.fillStyle = 'rgba(0,16,28,' + shadowFade.toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(x, yGround, r * 1.15, r * 0.62, 0, 0, TAU);
      ctx.fill();

      // Trail
      var g = ctx.createLinearGradient(x, y, x - ux * tail, y - uy * tail * TILT);
      if (p.superShot) {
        g.addColorStop(0, 'rgba(255,190,90,0.85)');
        g.addColorStop(0.45, 'rgba(255,110,50,0.40)');
        g.addColorStop(1, 'rgba(255,80,40,0)');
      } else {
        g.addColorStop(0, 'rgba(250,250,255,0.55)');
        g.addColorStop(0.5, 'rgba(200,225,240,0.22)');
        g.addColorStop(1, 'rgba(200,225,240,0)');
      }
      ctx.strokeStyle = g;
      ctx.lineWidth = r * 1.15;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - ux * tail, y - uy * tail * TILT);
      ctx.stroke();

      if (p.superShot) {
        ctx.save();
        ctx.shadowColor = '#ff6b3d';
        ctx.shadowBlur = 16 * z;
        ctx.fillStyle = '#ffd08a';
        ctx.beginPath(); ctx.arc(x, y, r * 1.35, 0, TAU); ctx.fill();
        ctx.fillStyle = '#ff7a3c';
        ctx.beginPath(); ctx.arc(x, y, r * 0.8, 0, TAU); ctx.fill();
        ctx.restore();
      } else {
        // A pale halo first: iron on deep blue water is otherwise very easy
        // to lose track of, which matters when you are dodging a broadside.
        ctx.fillStyle = 'rgba(226,242,250,0.55)';
        ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, TAU); ctx.fill();

        ctx.fillStyle = '#14141a';
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = Math.max(1, 1.3 * z);
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath(); ctx.arc(x - r * 0.32, y - r * 0.36, r * 0.34, 0, TAU); ctx.fill();
      }
    }
  };

  /** A short label that rises off the water and fades, e.g. a crate's name. */
  Renderer.prototype.addFloater = function (x, y, text, colour, big) {
    this.floaters.push({
      x: x, y: y, text: text, col: colour || '#f2ead6',
      t: 0, life: big ? 2.0 : 1.5, big: !!big
    });
    if (this.floaters.length > 24) this.floaters.shift();
  };

  Renderer.prototype.addPickupFloater = function (type, x, y, mine) {
    var look = PU_LOOK[type] || PU_LOOK.cannon;
    this.addFloater(x, y, PU_NAME[type] || 'Crate', look.ring, mine);
  };

  Renderer.prototype.drawFloaters = function (dt) {
    var ctx = this.ctx;
    var z = this.cam.zoom;
    var out = [];
    for (var i = 0; i < this.floaters.length; i++) {
      var f = this.floaters[i];
      f.t += dt;
      if (f.t >= f.life) continue;
      out.push(f);

      var k = f.t / f.life;
      var rise = 16 + 34 * k;                      // drifts up as it fades
      var alpha = k < 0.14 ? k / 0.14 : (1 - Math.pow((k - 0.14) / 0.86, 2.2));
      var x = this.sx(f.x);
      var y = this.sy(f.y, 0) - rise * z;
      var size = Math.max(11, (f.big ? 17 : 13.5) * z);

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = (f.big ? 'bold ' : '') + Math.round(size) + 'px "Trebuchet MS", sans-serif';
      ctx.lineWidth = Math.max(3, 3.5 * z);
      ctx.strokeStyle = 'rgba(2,14,24,0.9)';
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.col;
      ctx.fillText(f.text, x, y);
      ctx.restore();
    }
    this.floaters = out;
  };

  /** A ship reaching zero health blows up before it goes under. */
  Renderer.prototype.explodeShip = function (x, y, angle, col) {
    this.particles.burst('blast', x, y);
    this.particles.burst('debris', x, y, { count: 26, col: '126,86,48' });
    // A few planks in the colour of her stripe, so you can tell whose she was.
    for (var i = 0; i < 5; i++) {
      var a = Math.random() * TAU, sp = rnd(40, 150);
      this.particles.spawn({
        t: 'plank', x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rnd(1.5, 3.0), max: 3.0, r: rnd(3, 6), damp: 0.95,
        rot: Math.random() * TAU, spin: rnd(-4, 4), col: hexToRgb(col)
      });
    }
    this.addWreck(x, y, angle, col);
  };

  function hexToRgb(hex) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return '200,200,200';
    return parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16);
  }

  Renderer.prototype.addWreck = function (x, y, angle, col) {
    this.wrecks.push({ x: x, y: y, angle: angle, col: col, t: 0, life: 3.2, roll: rnd(-0.5, 0.5) });
  };

  Renderer.prototype.drawWrecks = function (dt) {
    var ctx = this.ctx;
    var z = this.cam.zoom;
    var out = [];
    for (var i = 0; i < this.wrecks.length; i++) {
      var w = this.wrecks[i];
      w.t += dt;
      if (w.t >= w.life) continue;
      out.push(w);

      var k = w.t / w.life;
      var x = this.sx(w.x), y = this.sy(w.y, 0);

      if (Math.random() < 0.4) this.particles.burst('bubble', w.x, w.y, { count: 1 });
      // Still burning for the first second or so as she settles.
      if (k < 0.45 && Math.random() < 0.5) {
        this.particles.spawn({
          t: 'smoke', x: w.x + rnd(-14, 14), y: w.y + rnd(-8, 8),
          vx: rnd(-8, 8), vy: rnd(-8, 8), life: rnd(0.9, 1.8), max: 1.8,
          r: rnd(5, 11), damp: 0.95, drift: 1.0, col: '62,58,56', z: 0, vz: 22, grav: 10
        });
      }

      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.translate(x, y + k * 6 * z);
      ctx.scale(z * (1 - k * 0.35), z * TILT * (1 - k * 0.35));
      ctx.rotate(w.angle + w.roll * k * 1.4);
      ctx.fillStyle = '#5c3d20';
      this.hullPath(ctx);
      ctx.fill();
      ctx.strokeStyle = w.col;
      ctx.lineWidth = 2.2;
      ctx.stroke();
      ctx.restore();
    }
    this.wrecks = out;
  };

  Renderer.prototype.drawParticles = function () {
    var ctx = this.ctx;
    var z = this.cam.zoom;
    var list = this.particles.list;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var k = p.life / p.max;
      var x = this.sx(p.x), y = this.sy(p.y, 0) - (p.z || 0) * z;

      switch (p.t) {
        case 'smoke':
          ctx.fillStyle = 'rgba(' + p.col + ',' + (0.42 * k).toFixed(3) + ')';
          ctx.beginPath();
          ctx.ellipse(x, y, p.r * z * (2.2 - k), p.r * z * (2.2 - k) * TILT, 0, 0, TAU);
          ctx.fill();
          break;
        case 'fire':
          ctx.fillStyle = 'rgba(255,' + Math.round(90 + 150 * k) + ',40,' + (0.9 * k).toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(x, y, p.r * z * (0.6 + k), 0, TAU); ctx.fill();
          break;
        case 'drop':
          ctx.fillStyle = 'rgba(224,244,252,' + (0.9 * k).toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(x, y, p.r * z, 0, TAU); ctx.fill();
          break;
        case 'ring':
          ctx.strokeStyle = 'rgba(225,245,252,' + (0.7 * k).toFixed(3) + ')';
          ctx.lineWidth = Math.max(1, 2 * z * k);
          ctx.beginPath();
          ctx.ellipse(x, y, (6 + (1 - k) * 34) * z, (6 + (1 - k) * 34) * z * TILT, 0, 0, TAU);
          ctx.stroke();
          break;
        case 'plank':
          ctx.save();
          ctx.translate(x, y); ctx.rotate(p.rot); ctx.scale(1, TILT);
          ctx.fillStyle = 'rgba(' + p.col + ',' + (0.95 * Math.min(1, k * 2)).toFixed(3) + ')';
          ctx.fillRect(-p.r * z, -p.r * z * 0.34, p.r * 2 * z, p.r * 0.68 * z);
          ctx.restore();
          break;
        case 'bubble':
          ctx.strokeStyle = 'rgba(210,240,250,' + (0.6 * k).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.ellipse(x, y, p.r * z, p.r * z * TILT, 0, 0, TAU); ctx.stroke();
          break;
        case 'spark':
          ctx.fillStyle = 'rgba(' + p.col + ',' + k.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(x, y, p.r * z * k, 0, TAU); ctx.fill();
          break;
        case 'flash':
          var fg = ctx.createRadialGradient(x, y, 0, x, y, p.r * z * (1.6 - k));
          fg.addColorStop(0, 'rgba(255,248,224,' + (0.92 * k).toFixed(3) + ')');
          fg.addColorStop(0.45, 'rgba(255,196,96,' + (0.55 * k).toFixed(3) + ')');
          fg.addColorStop(1, 'rgba(255,140,60,0)');
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.ellipse(x, y, p.r * z * (1.6 - k), p.r * z * TILT * (1.6 - k), 0, 0, TAU);
          ctx.fill();
          break;
        case 'shock':
          ctx.strokeStyle = 'rgba(255,236,200,' + (0.62 * k * k).toFixed(3) + ')';
          ctx.lineWidth = Math.max(1, 5 * z * k);
          ctx.beginPath();
          ctx.ellipse(x, y, (p.r + (1 - k) * 150) * z, (p.r + (1 - k) * 150) * z * TILT, 0, 0, TAU);
          ctx.stroke();
          break;
        case 'ember':
          ctx.fillStyle = 'rgba(255,' + Math.round(120 + 110 * k) + ',60,' + k.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(x, y, p.r * z, 0, TAU); ctx.fill();
          break;
        case 'wake':
          ctx.fillStyle = 'rgba(220,242,250,' + (0.20 * k).toFixed(3) + ')';
          ctx.beginPath();
          ctx.ellipse(x, y, p.r * z * (1 + (1 - k) * 1.6), p.r * z * TILT * (1 + (1 - k) * 1.6), 0, 0, TAU);
          ctx.fill();
          break;
      }
    }
  };

  // =====================================================================
  // Frame
  // =====================================================================

  Renderer.prototype.draw = function (state, dt) {
    this.time += dt;
    var ctx = this.ctx;

    // Camera
    var target = state.focus;
    if (target) {
      var k = 1 - Math.pow(0.0015, dt);
      this.cam.x = lerp(this.cam.x, target.x, k);
      this.cam.y = lerp(this.cam.y, target.y, k);
    }

    this.shake = Math.max(0, this.shake - dt * 2.4);
    var shx = 0, shy = 0;
    if (this.shake > 0) {
      var mag = this.shake * 9;
      shx = rnd(-mag, mag); shy = rnd(-mag, mag);
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.save();
    ctx.translate(shx, shy);

    this.particles.update(dt, state.wind.dir, state.wind.strength);

    this.drawSea(state);
    this.drawWhirlpools(state);
    this.drawTerrain();
    this.drawDecor();
    this.drawZoneWash(state);
    this.updateTrails(state);
    this.drawTrails(state);
    this.drawPowerups(state);
    this.drawWrecks(dt);
    this.drawShips(state);
    this.drawParticles();
    this.drawZoneBorder(state);
    this.drawProjectiles(state);
    this.updateGulls(dt, state);
    this.drawGulls();
    if (this.showEdge) this.drawEdgeFence();
    this.drawFloaters(dt);

    ctx.restore();
  };

  /** A faint marker at the world border so the hard stop is not a surprise. */
  Renderer.prototype.drawEdgeFence = function () {
    var ctx = this.ctx;
    var x0 = this.sx(0), x1 = this.sx(C.WORLD);
    var y0 = this.sy(0, 0), y1 = this.sy(C.WORLD, 0);
    ctx.save();
    ctx.strokeStyle = 'rgba(240,196,106,0.30)';
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 12]);
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    ctx.restore();
  };

  // =====================================================================
  // HUD canvases
  // =====================================================================

  Renderer.prototype.drawWindDial = function (canvas, wind, shipAngle) {
    var ctx = canvas.getContext('2d');
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h / 2 - 7, r = 42;
    var pow = clamp((wind.strength - C.WIND_MIN) / (C.WIND_MAX - C.WIND_MIN), 0, 1);
    ctx.clearRect(0, 0, w, h);

    // Dial face
    ctx.fillStyle = 'rgba(6,30,48,0.55)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(217,164,65,0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();

    // Strength arc around the rim - fills and warms as it pipes up.
    var strCol = pow < 0.34 ? '#7bdff2' : (pow < 0.7 ? '#9bde7e' : '#ffbe5c');
    ctx.strokeStyle = strCol;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, -Math.PI / 2, -Math.PI / 2 + TAU * Math.max(0.04, pow));
    ctx.stroke();

    ctx.fillStyle = 'rgba(205,194,166,0.55)';
    ctx.font = 'bold 10px "Trebuchet MS", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - r + 11);
    ctx.fillText('S', cx, cy + r - 11);
    ctx.fillText('W', cx - r + 11, cy);
    ctx.fillText('E', cx + r - 11, cy);

    // Your own heading, as a thin ghost needle behind the wind arrow.
    if (shipAngle !== null && shipAngle !== undefined) {
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(shipAngle);
      ctx.strokeStyle = 'rgba(242,234,214,0.42)';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(-r * 0.55, 0); ctx.lineTo(r * 0.7, 0); ctx.stroke();
      ctx.restore();
    }

    // The wind arrow: big, solid, and pointing where the wind is going.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(wind.dir);
    var len = r * (0.52 + 0.40 * pow);
    var head = 9 + 5 * pow;

    ctx.shadowColor = strCol;
    ctx.shadowBlur = 8 + 8 * pow;
    ctx.fillStyle = strCol;

    // Shaft with a feathered tail, drawn as one solid arrow.
    ctx.beginPath();
    ctx.moveTo(len + head * 0.9, 0);
    ctx.lineTo(len - head * 0.2, -head);
    ctx.lineTo(len - head * 0.2, -head * 0.38);
    ctx.lineTo(-len, -head * 0.34);
    ctx.lineTo(-len - head * 0.5, 0);
    ctx.lineTo(-len, head * 0.34);
    ctx.lineTo(len - head * 0.2, head * 0.38);
    ctx.lineTo(len - head * 0.2, head);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Speed lines behind the arrow when it is really blowing.
    if (pow > 0.55) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(wind.dir);
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.30 * pow).toFixed(2) + ')';
      ctx.lineWidth = 2;
      for (var k = -1; k <= 1; k += 2) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.9, k * (head + 5));
        ctx.lineTo(-r * 0.3, k * (head + 5));
        ctx.stroke();
      }
      ctx.restore();
    }
  };

  Renderer.prototype.drawMinimap = function (canvas, state) {
    var ctx = canvas.getContext('2d');
    var size = canvas.width;
    ctx.clearRect(0, 0, size, size);
    if (this.terrain && this.terrain.minimap) {
      ctx.drawImage(this.terrain.minimap, 0, 0, size, size);
    }
    var k = size / C.WORLD;

    // whirlpools
    for (var i = 0; i < state.whirlpools.length; i++) {
      var w = state.whirlpools[i];
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.arc(w.x * k, w.y * k, Math.max(2, w.r * k), 0, TAU); ctx.fill();
    }
    // power-ups
    ctx.fillStyle = 'rgba(240,196,106,0.9)';
    for (var j = 0; j < state.powerups.length; j++) {
      var p = state.powerups[j];
      ctx.fillRect(p.x * k - 1, p.y * k - 1, 2.5, 2.5);
    }
    // ships
    for (var s2 = 0; s2 < state.ships.length; s2++) {
      var s = state.ships[s2];
      if (!s.alive) continue;
      var mx = s.x * k, my = s.y * k;
      var me = s.id === state.meId;
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(mx, my, me ? 3.6 : 2.7, 0, TAU); ctx.fill();
      if (me) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.arc(mx, my, 5.4, 0, TAU); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(mx + Math.cos(s.angle) * 9, my + Math.sin(s.angle) * 9);
        ctx.stroke();
      }
    }
    // battle area
    if (state.zone) {
      var z = state.zone;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, size, size);
      ctx.rect(z[0] * k, z[1] * k, (z[2] - z[0]) * k, (z[3] - z[1]) * k);
      ctx.fillStyle = 'rgba(150,18,32,0.42)';
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(255,100,120,0.9)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(z[0] * k, z[1] * k, (z[2] - z[0]) * k, (z[3] - z[1]) * k);
      ctx.restore();
    }

    // viewport box
    var b = this.viewBounds();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(b.x0 * k, b.y0 * k, (b.x1 - b.x0) * k, (b.y1 - b.y0) * k);
  };

  Renderer.TILT = TILT;
  global.Renderer = Renderer;
})(window);
