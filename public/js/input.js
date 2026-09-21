/* Super Sinky - keyboard input.
 *
 * Only intent is captured here; the server decides what actually happens.
 * Input is sent when it changes and at a low heartbeat rate otherwise.
 */
(function (global) {
  'use strict';

  function Input(net) {
    this.net = net;
    this.enabled = false;
    this.keys = {};
    this.state = { t: 0, f: false, s: 1, b: false };
    this.lastSent = null;
    this.lastSendAt = 0;
    this.onEsc = null;
    this.onToggleHelp = null;
    this.onToggleMute = null;
    this._bind();
  }

  Input.prototype._bind = function () {
    var self = this;

    global.addEventListener('keydown', function (e) {
      if (!self.enabled) return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      var code = e.code || e.key;
      if (self._isGameKey(code)) e.preventDefault();
      if (self.keys[code]) return;           // ignore auto-repeat
      self.keys[code] = true;

      switch (code) {
        case 'KeyQ':
          self.state.s = -1; self.flush(true); break;
        case 'KeyE':
          self.state.s = 1; self.flush(true); break;
        case 'KeyS':
          self.state.s = -self.state.s; self.flush(true); break;
        case 'KeyH':
          if (self.onToggleHelp) self.onToggleHelp(); break;
        case 'KeyM':
          if (self.onToggleMute) self.onToggleMute(); break;
        case 'Escape':
          if (self.onEsc) self.onEsc(); break;
      }
      self._updateTurnFire();
    });

    global.addEventListener('keyup', function (e) {
      var code = e.code || e.key;
      if (!self.keys[code]) return;
      delete self.keys[code];
      if (!self.enabled) return;
      if (self._isGameKey(code)) e.preventDefault();
      self._updateTurnFire();
    });

    global.addEventListener('blur', function () {
      self.keys = {};
      self.state.t = 0;
      self.state.f = false;
      self.state.b = false;
      if (self.enabled) self.flush(true);
    });
  };

  Input.prototype._isGameKey = function (code) {
    return code === 'ArrowLeft' || code === 'ArrowRight' ||
      code === 'ArrowUp' || code === 'Space';
  };

  Input.prototype._updateTurnFire = function () {
    var left = this.keys.ArrowLeft || this.keys.KeyA;
    var right = this.keys.ArrowRight || this.keys.KeyD;
    var turn = (right ? 1 : 0) - (left ? 1 : 0);
    var fire = !!this.keys.Space;
    var boost = !!(this.keys.ArrowUp || this.keys.KeyW);
    if (turn !== this.state.t || fire !== this.state.f || boost !== this.state.b) {
      this.state.t = turn;
      this.state.f = fire;
      this.state.b = boost;
      this.flush(true);
    }
  };

  /** Send the current intent; `force` bypasses the change check. */
  Input.prototype.flush = function (force) {
    if (!this.enabled) return;
    var now = performance.now();
    var sig = this.state.t + '|' + (this.state.f ? 1 : 0) + '|' + this.state.s + '|' + (this.state.b ? 1 : 0);
    if (!force && sig === this.lastSent && now - this.lastSendAt < 250) return;
    this.lastSent = sig;
    this.lastSendAt = now;
    this.net.send({ t: 'in', d: this.state.t, f: this.state.f, s: this.state.s, b: this.state.b });
  };

  Input.prototype.setEnabled = function (on) {
    this.enabled = on;
    if (!on) { this.keys = {}; this.state.t = 0; this.state.f = false; this.state.b = false; }
  };

  Input.prototype.reset = function () {
    this.keys = {};
    this.state = { t: 0, f: false, s: 1, b: false };
    this.lastSent = null;
  };

  global.Input = Input;
})(window);
