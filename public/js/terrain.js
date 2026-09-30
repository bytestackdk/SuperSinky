/* Super Sinky - terrain baking.
 *
 * The server only sends a seed and a list of island cores. The client
 * re-evaluates the same continuous height field at a fine resolution and
 * bakes it once into an offscreen canvas, drawn in the tilted projection
 * with proper cliff faces so islands read as solid land rather than tiles.
 */
(function (global) {
  'use strict';

  var C = global.SSConst;
  var M = global.SSMap;

  var TILT = 0.72;          // vertical squash - the "slight angle" view
  var BAKE = 0.75;          // resolution of the baked terrain image
  var CELL = C.FINE;        // world units per sampled cell
  var ELEV_PAD = C.MAX_ELEV * 1.4;

  // ---- palette -------------------------------------------------------

  function lerpColor(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  var SAND_LO = [231, 214, 170], SAND_HI = [214, 195, 148];
  var GRASS_LO = [116, 176, 86], GRASS_HI = [63, 122, 54];
  var HILL_LO = [70, 118, 58], HILL_HI = [121, 124, 88];
  var ROCK_LO = [138, 132, 120], ROCK_HI = [222, 220, 214];

  function surfaceColor(h) {
    var B = C.BANDS;
    var rgb;
    if (h >= B[5].h) {
      rgb = lerpColor(ROCK_LO, ROCK_HI, Math.min(1, (h - B[5].h) / 0.14));
    } else if (h >= B[4].h) {
      rgb = lerpColor(HILL_LO, HILL_HI, (h - B[4].h) / (B[5].h - B[4].h));
    } else if (h >= B[3].h) {
      rgb = lerpColor(GRASS_LO, GRASS_HI, (h - B[3].h) / (B[4].h - B[3].h));
    } else {
      rgb = lerpColor(SAND_LO, SAND_HI, (h - B[2].h) / (B[3].h - B[2].h));
    }
    return rgb;
  }

  // ---- build ---------------------------------------------------------

  function Terrain(def) {
    this.def = def;
    this.gw = Math.ceil(C.WORLD / CELL);
    this.heights = new Float32Array(this.gw * this.gw);
    this.canvas = null;
    this.ctx = null;
    this.offsetY = ELEV_PAD * BAKE;
    this.ready = false;
    this.minimap = null;
  }

  Terrain.prototype.bakeWidth = function () { return Math.ceil(C.WORLD * BAKE); };
  Terrain.prototype.bakeHeight = function () { return Math.ceil(C.WORLD * TILT * BAKE + this.offsetY + 8); };

  /** World -> baked-image coordinates. */
  Terrain.prototype.bx = function (wx) { return wx * BAKE; };
  Terrain.prototype.by = function (wy, elev) { return wy * TILT * BAKE + this.offsetY - (elev || 0) * BAKE; };

  Terrain.prototype.heightAtCell = function (cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.gw || cy >= this.gw) return 0;
    return this.heights[cy * this.gw + cx];
  };

  /** Sample the height field only where islands can reach. */
  Terrain.prototype.sampleHeights = function () {
    var def = this.def, gw = this.gw;
    var touched = new Uint8Array(gw * gw);

    for (var i = 0; i < def.islands.length; i++) {
      var o = def.islands[i];
      var reach = o.r * 1.1;
      for (var k = 0; k < o.l.length; k++) {
        reach = Math.max(reach, o.r * (o.l[k].d + o.l[k].s) * 1.1);
      }
      var c0 = Math.max(0, Math.floor((o.x - reach) / CELL));
      var c1 = Math.min(gw - 1, Math.ceil((o.x + reach) / CELL));
      var r0 = Math.max(0, Math.floor((o.y - reach) / CELL));
      var r1 = Math.min(gw - 1, Math.ceil((o.y + reach) / CELL));

      for (var cy = r0; cy <= r1; cy++) {
        for (var cx = c0; cx <= c1; cx++) {
          var idx = cy * gw + cx;
          if (touched[idx]) continue;
          touched[idx] = 1;
          this.heights[idx] = M.heightAt(def, cx * CELL + CELL / 2, cy * CELL + CELL / 2);
        }
      }
    }
  };

  // ---- lighting -------------------------------------------------------

  // The sun sits to the north-west, as the ship shadows already assume, so
  // slopes facing it are lit, the far sides fall into shade, and hills throw
  // shadows south-east across lower ground and onto the water.
  // Mostly west rather than north, because the camera looks at the south
  // faces of every hill - a northern sun would leave them all in shade.
  var SUN_X = -0.86, SUN_Y = -0.42;              // toward the sun, on the map
  var SUN_Z = 0.66;                              // how high it stands
  var SUN_RISE = 0.55;                           // shadow ray climb per world unit
  var SHADOW_REACH = 12;                         // cells a shadow ray is marched

  function smooth01(e0, e1, x) {
    var t = (x - e0) / (e1 - e0);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return t * t * (3 - 2 * t);
  }

  /**
   * Per-cell grids the bake interpolates from: elevation, sunlight, cast
   * shadow and a low-frequency mottle. Built once on the coarse grid so the
   * per-pixel pass is only ever a handful of bilinear reads.
   */
  Terrain.prototype.prepareBake = function () {
    var gw = this.gw, n = gw * gw, H = this.heights;
    var wSand = C.BANDS[2].h;
    var E = new Float32Array(n);
    for (var i = 0; i < n; i++) E[i] = H[i] >= wSand ? M.elevFromHeight(H[i]) : 0;

    var light = new Float32Array(n);
    var shadow = new Float32Array(n);
    var mottle = new Float32Array(n);
    var len = Math.hypot(SUN_X, SUN_Y);
    var ux = SUN_X / len, uy = SUN_Y / len;

    for (var cy = 0; cy < gw; cy++) {
      for (var cx = 0; cx < gw; cx++) {
        var k = cy * gw + cx;
        var hash = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;
        mottle[k] = (hash % 1000) / 1000 - 0.5;

        if (H[k] < C.BANDS[1].h - 0.12 && E[k] === 0) {
          // Open water well clear of land still needs a shadow test below.
          light[k] = 1;
        } else {
          var ex = (E[cy * gw + Math.min(gw - 1, cx + 1)] - E[cy * gw + Math.max(0, cx - 1)]) / (2 * CELL);
          var ey = (E[Math.min(gw - 1, cy + 1) * gw + cx] - E[Math.max(0, cy - 1) * gw + cx]) / (2 * CELL);
          // Lambert against the surface normal (-ex, -ey, 1), relative to
          // flat ground so a level meadow keeps its true colour.
          var inv = 1 / Math.sqrt(ex * ex + ey * ey + 1);
          var dot = (-ex * SUN_X - ey * SUN_Y + SUN_Z) * inv;
          var l = 1 + 0.8 * (dot - SUN_Z);
          light[k] = l < 0.68 ? 0.68 : (l > 1.24 ? 1.24 : l);
        }

        // March toward the sun: anything standing above the ray shades us.
        var base = E[k], s = 0;
        for (var step = 1; step <= SHADOW_REACH; step++) {
          var sx = Math.round(cx + ux * step), sy = Math.round(cy + uy * step);
          if (sx < 0 || sy < 0 || sx >= gw || sy >= gw) break;
          var over = E[sy * gw + sx] - (base + step * CELL * SUN_RISE);
          if (over > 0) { s = Math.max(s, Math.min(1, over / 6) * (1 - step / (SHADOW_REACH + 2))); }
        }
        shadow[k] = s;
      }
    }

    this._E = E; this._light = light; this._shadow = shadow; this._mottle = mottle;

    // Which stretch of each grid column is worth visiting at all: land,
    // shallows, or water that a shadow falls on.
    var wTop = C.BANDS[1].h;
    var lo = new Int32Array(gw), hi = new Int32Array(gw);
    for (var c = 0; c < gw; c++) {
      lo[c] = gw; hi[c] = -1;
      for (var r = 0; r < gw; r++) {
        var q = r * gw + c;
        if (H[q] >= wTop - 0.02 || shadow[q] > 0) {
          if (r < lo[c]) lo[c] = r;
          hi[c] = r;
        }
      }
    }
    this._colLo = lo; this._colHi = hi;

    var W = this.bakeWidth(), Hh = this.bakeHeight();
    this.image = this.ctx.createImageData(W, Hh);
    this._px = new Uint32Array(this.image.data.buffer);
  };

  function pack(r, g, b, a) {
    r = r < 0 ? 0 : (r > 255 ? 255 : r);
    g = g < 0 ? 0 : (g > 255 ? 255 : g);
    b = b < 0 ? 0 : (b > 255 ? 255 : b);
    return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  }

  /**
   * Bake a band of image columns, voxel-space style: each column is walked
   * from the near (south) edge of the map to the far one, and every sample
   * paints from its lifted top down to whatever nearer ground already
   * covers. Slopes facing the camera therefore open up into real faces,
   * the far sides of hills are hidden behind them, and nothing is ever
   * drawn twice.
   */
  Terrain.prototype.bakeColumns = function (px0, px1) {
    var gw = this.gw, H = this.heights, E = this._E;
    var LI = this._light, SH = this._shadow, MO = this._mottle;
    var out = this._px;
    var W = this.image.width, IH = this.image.height;
    var B = C.BANDS;
    var wTop = B[1].h, wSand = B[2].h, wGrass = B[3].h, wHill = B[4].h, wRock = B[5].h;
    var rowStep = 1 / (TILT * BAKE);             // world units per image row of ground
    var inv = 1 / CELL;
    var rgb = [0, 0, 0];

    for (var px = px0; px < px1 && px < W; px++) {
      var wx = (px + 0.5) / BAKE;
      var gx = wx * inv - 0.5;
      var x0 = Math.floor(gx), fx = gx - x0;
      if (x0 < 0) { x0 = 0; fx = 0; }
      if (x0 >= gw - 1) { x0 = gw - 2; fx = 1; }

      var rLo = Math.min(this._colLo[x0], this._colLo[x0 + 1]);
      var rHi = Math.max(this._colHi[x0], this._colHi[x0 + 1]);
      if (rHi < 0) continue;
      var wyHi = Math.min(C.WORLD, (rHi + 2) * CELL);
      var wyLo = Math.max(0, (rLo - 1) * CELL);

      var ymin = IH;
      for (var wy = wyHi; wy >= wyLo; wy -= rowStep) {
        var gy = wy * inv - 0.5;
        var y0 = Math.floor(gy), fy = gy - y0;
        if (y0 < 0) { y0 = 0; fy = 0; }
        if (y0 >= gw - 1) { y0 = gw - 2; fy = 1; }
        var i00 = y0 * gw + x0, i10 = i00 + 1, i01 = i00 + gw, i11 = i01 + 1;
        var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;

        var h = H[i00] * w00 + H[i10] * w10 + H[i01] * w01 + H[i11] * w11;
        var sh = SH[i00] * w00 + SH[i10] * w10 + SH[i01] * w01 + SH[i11] * w11;
        var baseY = wy * TILT * BAKE + this.offsetY;

        if (h < wSand) {
          // Water: open sea stays clear so the animated swell shows through;
          // shallows and surf are a translucent wash over it.
          var top = Math.round(baseY);
          if (top >= ymin) continue;
          var col = 0;
          var mo0 = MO[i00] * w00 + MO[i10] * w10 + MO[i01] * w01 + MO[i11] * w11;
          if (h >= wTop - 0.04) {
            var t = smooth01(wTop - 0.04, wSand, h);
            var foam = smooth01(0.80, 0.97, t + mo0 * 0.10);
            var r = 70 + 110 * t + 75 * foam, g = 170 + 60 * t + 25 * foam, b = 196 + 34 * t + 25 * foam;
            var a = 0.40 * t + 0.40 * foam;
            if (sh > 0) { r *= 1 - 0.35 * sh; g *= 1 - 0.3 * sh; b *= 1 - 0.25 * sh; a += 0.12 * sh; }
            col = pack(r, g, b, Math.round(Math.min(1, a) * 255));
          } else if (sh > 0.02) {
            col = pack(2, 22, 38, Math.round(0.26 * sh * 255));
          }
          if (col) for (var yy = top; yy < ymin; yy++) if (yy >= 0) out[yy * W + px] = col;
          ymin = top;
          continue;
        }

        var elev = M.elevFromHeight(h);
        var topL = Math.round(baseY - elev * BAKE);
        if (topL >= ymin) continue;

        var li = LI[i00] * w00 + LI[i10] * w10 + LI[i01] * w01 + LI[i11] * w11;
        var mo = MO[i00] * w00 + MO[i10] * w10 + MO[i01] * w01 + MO[i11] * w11;
        landColor(h, mo, rgb, wSand, wGrass, wHill, wRock);

        var f = li * (1 - 0.34 * sh);
        var grain = 1 + (((px * 2654435761 ^ topL * 40503) >>> 0) % 64 - 32) / 1100;
        var span = ymin - topL;
        for (var k = 0; k < span; k++) {
          var yk = topL + k;
          if (yk < 0) continue;
          // Deeper into a tall span is a face turned to the camera: darken
          // it progressively so cliffs read as solid rock, not smears.
          var face = k < 2 ? 1 : Math.max(0.74, 0.94 - (k - 2) * 0.012);
          var ff = f * face * grain;
          out[yk * W + px] = pack(rgb[0] * ff, rgb[1] * ff, rgb[2] * ff, 255);
        }
        ymin = topL;
      }
    }
  };

  /** Surface colour at height h, blended smoothly across the bands. */
  function landColor(h, mo, out, wSand, wGrass, wHill, wRock) {
    var c;
    // Wet sand right at the waterline, drying up the beach.
    var s = lerpColor(SAND_LO, SAND_HI, clamp01((h - wSand) / (wGrass - wSand)));
    var wet = 1 - smooth01(wSand, wSand + 0.018, h);
    s[0] -= 34 * wet; s[1] -= 30 * wet; s[2] -= 22 * wet;
    var gr = lerpColor(GRASS_LO, GRASS_HI, clamp01((h - wGrass) / (wHill - wGrass)));
    var hl = lerpColor(HILL_LO, HILL_HI, clamp01((h - wHill) / (wRock - wHill)));
    var rk = lerpColor(ROCK_LO, ROCK_HI, clamp01((h - wRock) / 0.14));

    var tg = smooth01(wGrass - 0.006, wGrass + 0.008, h + mo * 0.008);
    var th = smooth01(wHill - 0.02, wHill + 0.02, h + mo * 0.02);
    var tr = smooth01(wRock - 0.012, wRock + 0.012, h + mo * 0.01);
    c = mix3(s, gr, tg);
    c = mix3(c, hl, th);
    c = mix3(c, rk, tr);

    // Mottle the vegetation so a meadow is not one flat swatch.
    var veg = tg * (1 - tr);
    out[0] = c[0] * (1 + mo * (0.08 * veg + 0.04));
    out[1] = c[1] * (1 + mo * (0.15 * veg + 0.04));
    out[2] = c[2] * (1 + mo * (0.06 * veg + 0.04));
  }

  function mix3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function clamp01(t) { return t < 0 ? 0 : (t > 1 ? 1 : t); }

  Terrain.prototype.finishBake = function () {
    this.ctx.putImageData(this.image, 0, 0);
    // Only the canvas is needed from here on.
    this.image = null; this._px = null;
    this._light = this._shadow = this._mottle = this._E = null;
  };

  /** The whole bake in one go (tests, and anything that cannot wait). */
  Terrain.prototype.bake = function () {
    this.prepareBake();
    this.bakeColumns(0, this.bakeWidth());
    this.finishBake();
  };

  Terrain.prototype.buildMinimap = function (size) {
    var mc = document.createElement('canvas');
    mc.width = mc.height = size;
    var mctx = mc.getContext('2d');
    var gw = this.gw;
    var step = gw / size;
    var img = mctx.createImageData(size, size);
    var B = C.BANDS;

    for (var py = 0; py < size; py++) {
      for (var px = 0; px < size; px++) {
        var cx = Math.min(gw - 1, Math.floor(px * step));
        var cy = Math.min(gw - 1, Math.floor(py * step));
        var h = this.heights[cy * gw + cx];
        var o = (py * size + px) * 4;
        var rgb;
        if (h < B[1].h) rgb = [16, 60, 96];
        else if (h < B[2].h) rgb = [38, 104, 140];
        else rgb = surfaceColor(h);
        img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
      }
    }
    mctx.putImageData(img, 0, 0);
    this.minimap = mc;
  };

  /**
   * Build over several frames so the browser stays responsive and we can
   * show progress instead of a white screen.
   */
  Terrain.prototype.buildAsync = function (onProgress, onDone) {
    var self = this;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.bakeWidth();
    this.canvas.height = this.bakeHeight();
    this.ctx = this.canvas.getContext('2d');

    var phase = 0;
    var px = 0;
    var W = this.bakeWidth();
    var FRAME_BUDGET_MS = 12;      // keep the progress bar (and the page) moving

    function step() {
      if (phase === 0) {
        self.sampleHeights();
        phase = 1;
        onProgress(0.3);
        requestAnimationFrame(step);
        return;
      }
      if (phase === 1) {
        self.prepareBake();
        phase = 2;
        onProgress(0.38);
        requestAnimationFrame(step);
        return;
      }
      if (phase === 2) {
        var t0 = performance.now();
        while (px < W && performance.now() - t0 < FRAME_BUDGET_MS) {
          var end = Math.min(W, px + 48);
          self.bakeColumns(px, end);
          px = end;
        }
        onProgress(0.38 + 0.57 * (px / W));
        if (px >= W) { self.finishBake(); phase = 3; }
        requestAnimationFrame(step);
        return;
      }
      self.buildMinimap(190);
      self.ready = true;
      onProgress(1);
      onDone(self);
    }

    requestAnimationFrame(step);
  };

  Terrain.TILT = TILT;
  Terrain.BAKE = BAKE;
  global.Terrain = Terrain;
})(window);
