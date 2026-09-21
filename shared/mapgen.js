/* Super Sinky - deterministic island map generation, shared by server & client.
 *
 * The server sends only a compact map definition (seed + island list). Both
 * sides can then evaluate the exact same continuous height field, so the
 * server can build a tile grid for collision/line-of-sight while the client
 * samples it finely for smooth, organic looking coastlines.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./constants.js'));
  else root.SSMap = factory(root.SSConst);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  // ---- deterministic pseudo randomness --------------------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash2(ix, iy, seed) {
    var h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function smooth(t) { return t * t * (3 - 2 * t); }

  // Classic value noise, one octave.
  function valueNoise(x, y, seed) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = smooth(x - x0), fy = smooth(y - y0);
    var a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
    var c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  }

  function fbm(x, y, seed, octaves) {
    var sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (var i = 0; i < octaves; i++) {
      sum += valueNoise(x * freq, y * freq, seed + i * 7919) * amp;
      norm += amp;
      amp *= 0.5; freq *= 2.07;
    }
    return sum / norm;
  }

  // ---- map definition -------------------------------------------------
  function makeMapDef(seed) {
    seed = (seed >>> 0) || 1;
    var rnd = mulberry32(seed);
    var W = C.WORLD;
    var margin = C.EDGE_MARGIN;
    var islands = [];
    var wanted = 9 + Math.floor(rnd() * 5); // 9..13 island cores
    var guard = 0;

    while (islands.length < wanted && guard++ < 900) {
      var r = 125 + rnd() * 250;
      var x = margin + r * 0.5 + rnd() * (W - 2 * (margin + r * 0.5));
      var y = margin + r * 0.5 + rnd() * (W - 2 * (margin + r * 0.5));
      var ok = true;
      for (var i = 0; i < islands.length; i++) {
        var o = islands[i];
        var d = Math.hypot(o.x - x, o.y - y);
        if (d < (o.r + r) * 0.82) { ok = false; break; }
      }
      if (!ok) continue;

      // Peak decides how tall the island gets: small skerries stay flat,
      // big islands grow hills and mountains that block cannon fire.
      var peak = 0.46 + rnd() * 0.62;
      if (r < 150) peak = Math.min(peak, 0.55);
      islands.push({
        x: Math.round(x), y: Math.round(y), r: Math.round(r),
        p: Math.round(peak * 1000) / 1000,
        // a couple of satellite lobes keep the outline from being a circle
        l: [
          { a: Math.round(rnd() * 6283) / 1000, d: 0.45 + Math.round(rnd() * 400) / 1000, s: 0.4 + Math.round(rnd() * 350) / 1000 },
          { a: Math.round(rnd() * 6283) / 1000, d: 0.45 + Math.round(rnd() * 400) / 1000, s: 0.4 + Math.round(rnd() * 350) / 1000 }
        ]
      });
    }

    return { seed: seed, w: W, h: W, islands: islands };
  }

  // ---- the continuous height field ------------------------------------

  /**
   * Flatten the island cores and their satellite lobes into one plain list of
   * circular bumps. This is cached on the definition (non-enumerable, so it
   * never travels over the wire) because the height field is evaluated
   * hundreds of thousands of times when the client bakes the map, and doing
   * the lobe trigonometry per sample dominated that cost.
   */
  function lobesOf(def) {
    if (def._lobes) return def._lobes;
    var out = [];
    for (var i = 0; i < def.islands.length; i++) {
      var o = def.islands[i];
      out.push({ x: o.x, y: o.y, r2: o.r * o.r, p: o.p });
      for (var k = 0; k < o.l.length; k++) {
        var lb = o.l[k];
        var lr = o.r * lb.s;
        out.push({
          x: o.x + Math.cos(lb.a) * o.r * lb.d,
          y: o.y + Math.sin(lb.a) * o.r * lb.d,
          r2: lr * lr,
          p: o.p * 0.86
        });
      }
    }
    try {
      Object.defineProperty(def, '_lobes', { value: out, enumerable: false });
    } catch (e) {
      def._lobes = out;
    }
    return out;
  }

  function heightAt(def, x, y) {
    var lobes = def._lobes || lobesOf(def);
    var h = 0;
    for (var i = 0; i < lobes.length; i++) {
      var o = lobes[i];
      var dx = x - o.x, dy = y - o.y;
      var d2 = dx * dx + dy * dy;
      if (d2 >= o.r2) continue;
      var t = 1 - d2 / o.r2;            // 1 at the centre, 0 at the rim
      var v = o.p * t * t;
      if (v > h) h = v;
    }

    // Open sea: no island reaches here, so skip the noise entirely.
    if (h <= 0.001) return 0;

    // Warp the shape with noise so coastlines look eroded, not circular.
    var n = fbm(x / 340, y / 340, def.seed, 4);
    h = h * (0.66 + 0.60 * n);
    h += (n - 0.5) * 0.10 * Math.min(1, h * 4);

    // Force water along the map border.
    var m = C.EDGE_MARGIN;
    var edge = Math.min(x, y, def.w - x, def.h - y);
    if (edge < m) h *= Math.max(0, edge / m);

    return h < 0 ? 0 : h;
  }

  function terrainFromHeight(h) {
    var B = C.BANDS;
    for (var i = B.length - 1; i >= 0; i--) if (h >= B[i].h) return B[i].t;
    return C.TERRAIN.WATER;
  }

  function elevOf(terrain) {
    for (var i = 0; i < C.BANDS.length; i++) if (C.BANDS[i].t === terrain) return C.BANDS[i].elev;
    return 0;
  }

  // Smooth elevation for rendering (avoids hard steps inside a band).
  function elevFromHeight(h) {
    var B = C.BANDS;
    for (var i = B.length - 1; i >= 1; i--) {
      if (h >= B[i].h) {
        var lo = B[i].h;
        var hi = (i + 1 < B.length) ? B[i + 1].h : lo + 0.16;
        var t = Math.min(1, (h - lo) / (hi - lo));
        var e0 = B[i].elev;
        var e1 = (i + 1 < B.length) ? B[i + 1].elev : e0 + 14;
        return e0 + (e1 - e0) * t;
      }
    }
    return 0;
  }

  return {
    mulberry32: mulberry32,
    fbm: fbm,
    makeMapDef: makeMapDef,
    lobesOf: lobesOf,
    heightAt: heightAt,
    terrainFromHeight: terrainFromHeight,
    elevOf: elevOf,
    elevFromHeight: elevFromHeight
  };
});
