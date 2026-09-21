/* Super Sinky - procedural sound engine.
 *
 * Everything is synthesised with WebAudio, so the game ships without a single
 * audio asset. Sounds are positional: they fade with distance from the camera
 * and pan with their bearing. Each effect is layered rather than a single
 * beep - a transient to give it an attack, a body, and a tail - which is what
 * makes a cannon read as a cannon instead of a click.
 */
(function (global) {
  'use strict';

  var ctx = null;
  var master = null;
  var comp = null;
  var muted = false;
  var noiseBuf = null;
  var VOLUME = 0.5;

  function ensure() {
    if (ctx) return true;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { return false; }

    // A compressor keeps a full broadside from clipping while still letting
    // the quiet details through.
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 7;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    master = ctx.createGain();
    master.gain.value = muted ? 0 : VOLUME;

    comp.connect(master);
    master.connect(ctx.destination);

    // Two seconds of white noise, reused everywhere.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  function resume() {
    if (ensure() && ctx.state === 'suspended') ctx.resume();
  }

  function now() { return ctx.currentTime; }
  function rnd(a, b) { return a + Math.random() * (b - a); }

  /** Output chain for one voice: gain -> optional pan -> compressor. */
  function out(vol, pan) {
    var g = ctx.createGain();
    g.gain.value = 0;
    if (pan && ctx.createStereoPanner) {
      var pn = ctx.createStereoPanner();
      pn.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(pn); pn.connect(comp);
    } else {
      g.connect(comp);
    }
    return g;
  }

  /**
   * A shaped noise burst. `curve` picks the envelope: 'hit' is a hard attack
   * with an exponential tail, 'swell' fades in and back out.
   */
  function noise(o) {
    var t0 = now() + (o.delay || 0);
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = o.rate || 1;

    var filt = ctx.createBiquadFilter();
    filt.type = o.type || 'lowpass';
    filt.Q.value = o.q || 1;
    filt.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 && o.f1 !== o.f0) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(30, o.f1), t0 + o.dur);
    }

    var g = out(o.vol, o.pan);
    var peak = Math.max(0.0001, o.vol);
    if (o.curve === 'swell') {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + o.dur * 0.35);
    } else {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.004));
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    src.connect(filt); filt.connect(g);
    src.start(t0);
    src.stop(t0 + o.dur + 0.03);
  }

  /** A pitched voice, optionally swept. */
  function tone(o) {
    var t0 = now() + (o.delay || 0);
    var osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 && o.f1 !== o.f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(18, o.f1), t0 + o.dur);
    }

    var node = osc;
    if (o.wobble) {
      // Slow vibrato - used to make the whirlpool sound alive.
      var lfo = ctx.createOscillator();
      lfo.frequency.value = o.wobble;
      var depth = ctx.createGain();
      depth.gain.value = o.wobbleDepth || 18;
      lfo.connect(depth); depth.connect(osc.frequency);
      lfo.start(t0); lfo.stop(t0 + o.dur + 0.03);
    }

    var g = out(o.vol, o.pan);
    var peak = Math.max(0.0001, o.vol);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);

    node.connect(g);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.03);
  }

  var Sfx = {
    setMuted: function (m) {
      muted = m;
      if (master) master.gain.value = m ? 0 : VOLUME;
      return muted;
    },
    isMuted: function () { return muted; },
    toggle: function () { return Sfx.setMuted(!muted); },
    resume: resume,

    /**
     * kind - which effect
     * vol  - 0..1, already attenuated by distance by the caller
     * pan  - -1 (left) .. 1 (right), from the bearing to the camera
     * n    - how many guns, for 'fire'
     */
    play: function (kind, vol, pan, n) {
      if (muted || vol <= 0.01 || !ensure()) return;
      if (ctx.state === 'suspended') return;
      vol = Math.min(1, vol);
      pan = pan || 0;
      var v = vol;

      switch (kind) {
        case 'fire': {
          // One ragged report per gun, a few milliseconds apart, so a
          // six-gun broadside rolls instead of cracking all at once.
          var guns = Math.max(1, Math.min(6, n || 2));
          for (var i = 0; i < guns; i++) {
            var d = i * rnd(0.022, 0.05);
            var j = rnd(0.88, 1.12);
            noise({ dur: 0.05, vol: 0.42 * v, type: 'highpass', f0: 1400 * j, f1: 4200, delay: d, pan: pan, attack: 0.001 });
            noise({ dur: 0.34, vol: 0.5 * v, type: 'lowpass', f0: 1100 * j, f1: 120, delay: d, pan: pan });
            tone({ type: 'triangle', f0: 132 * j, f1: 38, dur: 0.24, vol: 0.30 * v, delay: d, pan: pan });
            tone({ type: 'sine', f0: 62 * j, f1: 28, dur: 0.38, vol: 0.26 * v, delay: d, pan: pan });
          }
          // The report rolling away across the water.
          noise({ dur: 0.85, vol: 0.10 * v, type: 'lowpass', f0: 420, f1: 90, delay: 0.09, pan: pan * 0.5, curve: 'swell' });
          break;
        }

        case 'hit':
          // Iron into oak: a crack, splintering, and a hollow boom below.
          noise({ dur: 0.05, vol: 0.45 * v, type: 'highpass', f0: 2600, f1: 6000, attack: 0.001, pan: pan });
          noise({ dur: 0.26, vol: 0.40 * v, type: 'bandpass', f0: 1500, f1: 420, q: 1.6, pan: pan });
          tone({ type: 'square', f0: 190, f1: 52, dur: 0.20, vol: 0.20 * v, pan: pan });
          tone({ type: 'sine', f0: 88, f1: 36, dur: 0.34, vol: 0.24 * v, pan: pan });
          break;

        case 'splash':
          // Plume, then the water falling back in.
          noise({ dur: 0.09, vol: 0.30 * v, type: 'highpass', f0: 900, f1: 3400, attack: 0.002, pan: pan });
          noise({ dur: 0.34, vol: 0.20 * v, type: 'bandpass', f0: 2600, f1: 700, q: 0.8, delay: 0.05, pan: pan });
          tone({ type: 'sine', f0: 420, f1: 150, dur: 0.14, vol: 0.10 * v, delay: 0.02, pan: pan });
          break;

        case 'rock':
          noise({ dur: 0.07, vol: 0.38 * v, type: 'highpass', f0: 3000, f1: 7000, attack: 0.001, pan: pan });
          noise({ dur: 0.30, vol: 0.26 * v, type: 'bandpass', f0: 2200, f1: 600, q: 2.4, pan: pan });
          tone({ type: 'square', f0: 260, f1: 90, dur: 0.12, vol: 0.12 * v, pan: pan });
          break;

        case 'explode':
          // Flash, body, and a long sub-bass drop rolling away.
          noise({ dur: 0.07, vol: 0.62 * v, type: 'highpass', f0: 2200, f1: 7000, attack: 0.001, pan: pan });
          noise({ dur: 0.55, vol: 0.60 * v, type: 'lowpass', f0: 2000, f1: 140, pan: pan });
          noise({ dur: 1.5, vol: 0.26 * v, type: 'lowpass', f0: 700, f1: 70, delay: 0.06, pan: pan * 0.6, curve: 'swell' });
          tone({ type: 'sawtooth', f0: 210, f1: 26, dur: 0.75, vol: 0.40 * v, pan: pan });
          tone({ type: 'sine', f0: 96, f1: 20, dur: 1.15, vol: 0.42 * v, pan: pan });
          break;

        case 'sink':
          // Timbers groaning, then water closing over her.
          tone({ type: 'sawtooth', f0: 260, f1: 44, dur: 1.15, vol: 0.20 * v, wobble: 5.5, wobbleDepth: 12, pan: pan });
          noise({ dur: 1.3, vol: 0.30 * v, type: 'lowpass', f0: 1200, f1: 130, delay: 0.15, pan: pan, curve: 'swell' });
          noise({ dur: 0.7, vol: 0.14 * v, type: 'bandpass', f0: 600, f1: 2200, q: 0.7, delay: 0.5, pan: pan });
          break;

        case 'pickup': {
          // A bright little major arpeggio - unmistakably a good thing.
          var notes = [660, 880, 1320];
          for (var k = 0; k < notes.length; k++) {
            tone({ type: 'triangle', f0: notes[k], f1: notes[k], dur: 0.16, vol: 0.20 * v, delay: k * 0.055, pan: pan, attack: 0.004 });
            tone({ type: 'sine', f0: notes[k] * 2, f1: notes[k] * 2, dur: 0.10, vol: 0.07 * v, delay: k * 0.055, pan: pan });
          }
          break;
        }

        case 'ram':
          // A heavy wooden crunch with a shove of low end behind it.
          noise({ dur: 0.10, vol: 0.40 * v, type: 'bandpass', f0: 800, f1: 260, q: 1.2, attack: 0.002, pan: pan });
          noise({ dur: 0.55, vol: 0.40 * v, type: 'lowpass', f0: 520, f1: 80, pan: pan });
          tone({ type: 'square', f0: 104, f1: 34, dur: 0.34, vol: 0.26 * v, pan: pan });
          tone({ type: 'sine', f0: 58, f1: 24, dur: 0.5, vol: 0.28 * v, pan: pan });
          break;

        case 'ground':
          // Hull dragging over shingle.
          noise({ dur: 0.65, vol: 0.30 * v, type: 'bandpass', f0: 1100, f1: 260, q: 0.6, pan: pan, curve: 'swell' });
          noise({ dur: 0.35, vol: 0.20 * v, type: 'lowpass', f0: 600, f1: 110, pan: pan });
          tone({ type: 'triangle', f0: 90, f1: 40, dur: 0.4, vol: 0.14 * v, pan: pan });
          break;

        case 'whirl':
          // A rising, circling suck of water.
          tone({ type: 'sine', f0: 70, f1: 230, dur: 1.5, vol: 0.20 * v, wobble: 3.2, wobbleDepth: 26, pan: pan });
          noise({ dur: 1.6, vol: 0.16 * v, type: 'bandpass', f0: 300, f1: 1400, q: 3.5, pan: pan, curve: 'swell' });
          break;

        case 'spawn':
          tone({ type: 'triangle', f0: 330, f1: 660, dur: 0.22, vol: 0.16 * v, pan: pan });
          noise({ dur: 0.3, vol: 0.14 * v, type: 'highpass', f0: 700, f1: 2600, pan: pan });
          break;

        case 'gull': {
          // Two or three descending cries, each a quick up-then-down squeal.
          var cries = 2 + (Math.random() < 0.5 ? 1 : 0);
          var base = rnd(900, 1250);
          for (var c = 0; c < cries; c++) {
            var f = base * Math.pow(0.88, c) * rnd(0.95, 1.05);
            var at = c * rnd(0.17, 0.26);
            tone({ type: 'sawtooth', f0: f * 0.62, f1: f, dur: 0.05, vol: 0.045 * v, delay: at, attack: 0.012 });
            tone({ type: 'sawtooth', f0: f, f1: f * 0.52, dur: 0.17, vol: 0.055 * v, delay: at + 0.05 });
            noise({ dur: 0.1, vol: 0.016 * v, type: 'bandpass', f0: f * 1.4, f1: f * 0.7, q: 5, delay: at + 0.04 });
          }
          break;
        }

        case 'boost':
          // A sudden press of canvas and a surge of water under the counter.
          noise({ dur: 0.55, vol: 0.30 * v, type: 'bandpass', f0: 380, f1: 1700, q: 0.7, curve: 'swell', pan: pan });
          noise({ dur: 0.9, vol: 0.18 * v, type: 'highpass', f0: 600, f1: 2400, delay: 0.1, pan: pan, curve: 'swell' });
          tone({ type: 'sine', f0: 120, f1: 300, dur: 0.5, vol: 0.16 * v, pan: pan });
          break;

        case 'shrink':
          // A low horn: the battle area is closing in.
          tone({ type: 'sawtooth', f0: 150, f1: 112, dur: 0.85, vol: 0.20 * v, attack: 0.05 });
          tone({ type: 'square', f0: 75, f1: 56, dur: 1.0, vol: 0.14 * v, attack: 0.06 });
          tone({ type: 'sine', f0: 300, f1: 224, dur: 0.7, vol: 0.07 * v, delay: 0.08, attack: 0.05 });
          break;

        case 'ready':
          // Two quiet clicks: the guns run out.
          tone({ type: 'square', f0: 1240, f1: 1240, dur: 0.035, vol: 0.07 * v });
          tone({ type: 'square', f0: 1660, f1: 1660, dur: 0.05, vol: 0.06 * v, delay: 0.06 });
          break;
      }
    }
  };

  global.Sfx = Sfx;
})(window);
