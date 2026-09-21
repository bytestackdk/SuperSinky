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

  function shade(rgb, f) {
    return 'rgb(' + Math.round(rgb[0] * f) + ',' + Math.round(rgb[1] * f) + ',' + Math.round(rgb[2] * f) + ')';
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

  /** Draw one horizontal band of cells into the bake canvas. */
  Terrain.prototype.bakeRows = function (cy0, cy1) {
    var ctx = this.ctx, gw = this.gw;
    var B = C.BANDS;
    var wTop = C.BANDS[1].h;     // shallow threshold
    var wSand = C.BANDS[2].h;
    var cw = CELL * BAKE + 0.9;                 // slight overlap kills seams
    var ch = CELL * TILT * BAKE + 0.9;

    for (var cy = cy0; cy < cy1; cy++) {
      for (var cx = 0; cx < gw; cx++) {
        var h = this.heights[cy * gw + cx];
        if (h < wTop) continue;

        var wx = cx * CELL, wy = cy * CELL;

        if (h < wSand) {
          // Shallows and surf: a translucent wash over the animated sea.
          var t = (h - wTop) / (wSand - wTop);
          var x = this.bx(wx), y = this.by(wy, 0);
          ctx.fillStyle = 'rgba(150, 214, 226,' + (0.10 + 0.24 * t).toFixed(3) + ')';
          ctx.fillRect(x, y, cw, ch);
          if (t > 0.72) {
            ctx.fillStyle = 'rgba(255,255,255,' + (0.30 * (t - 0.72) / 0.28).toFixed(3) + ')';
            ctx.fillRect(x, y, cw, ch);
          }
          continue;
        }

        var elev = M.elevFromHeight(h);
        var rgb = surfaceColor(h);

        // Cheap per-cell dither so large areas are not flat.
        var n = ((cx * 73856093) ^ (cy * 19349663)) >>> 0;
        var jitter = 0.94 + ((n % 100) / 100) * 0.12;

        var bxp = this.bx(wx);
        var byp = this.by(wy, elev);

        // Cliff face down to whatever the cell below sits at.
        var hBelow = this.heightAtCell(cx, cy + 1);
        var elevBelow = hBelow >= wSand ? M.elevFromHeight(hBelow) : 0;
        var drop = elev - elevBelow;
        if (drop > 0.4) {
          var faceTop = this.by(wy + CELL, elev);
          var faceH = drop * BAKE + 0.9;
          var steep = Math.min(1, drop / 22);
          ctx.fillStyle = shade(rgb, (0.44 + 0.14 * (1 - steep)) * jitter);
          ctx.fillRect(bxp, faceTop, cw, faceH);
        }

        // Top face.
        ctx.fillStyle = shade(rgb, jitter);
        ctx.fillRect(bxp, byp, cw, ch);

        // Sunlit north edge for a little relief.
        var hAbove = this.heightAtCell(cx, cy - 1);
        var elevAbove = hAbove >= wSand ? M.elevFromHeight(hAbove) : 0;
        if (elev - elevAbove > 1.2) {
          ctx.fillStyle = 'rgba(255,255,240,0.16)';
          ctx.fillRect(bxp, byp, cw, Math.min(ch, (elev - elevAbove) * BAKE * 0.5 + 1));
        }
      }
    }
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
    var cy = 0;
    var ROWS_PER_FRAME = 44;

    function step() {
      if (phase === 0) {
        self.sampleHeights();
        phase = 1;
        onProgress(0.35);
        requestAnimationFrame(step);
        return;
      }
      if (phase === 1) {
        var end = Math.min(self.gw, cy + ROWS_PER_FRAME);
        self.bakeRows(cy, end);
        cy = end;
        onProgress(0.35 + 0.6 * (cy / self.gw));
        if (cy >= self.gw) { phase = 2; }
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
