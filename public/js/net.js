/* Super Sinky - WebSocket client with snapshot buffering. */
(function (global) {
  'use strict';

  function Net() {
    this.ws = null;
    this.connected = false;
    this.clientId = 0;
    this.handlers = {};
    this.queue = [];
    this.ping = 0;
    this.everOpen = false;
    this.closing = false;
    this.attempts = 0;
    this._pingTimer = null;
    this._retryTimer = null;
  }

  Net.prototype.on = function (type, fn) {
    (this.handlers[type] || (this.handlers[type] = [])).push(fn);
    return this;
  };

  Net.prototype.emit = function (type, msg) {
    var hs = this.handlers[type];
    if (!hs) return;
    for (var i = 0; i < hs.length; i++) hs[i](msg);
  };

  Net.prototype.connect = function () {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }

    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = proto + '//' + location.host;
    var self = this;

    try {
      this.ws = new WebSocket(url);
    } catch (e) {
      this._scheduleRetry();
      return;
    }

    this.ws.onopen = function () {
      self.connected = true;
      var reopened = self.everOpen;
      self.everOpen = true;
      self.attempts = 0;

      // Listeners run first so identity (the player's name) goes out ahead of
      // anything the user queued while the line was down.
      self.emit('open', { reopened: reopened });

      var pending = self.queue;
      self.queue = [];
      for (var i = 0; i < pending.length; i++) self.ws.send(pending[i]);

      self._pingTimer = setInterval(function () { self.send({ t: 'ping', c: performance.now() }); }, 3000);
    };

    this.ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'pong') {
        self.ping = Math.round(performance.now() - msg.c);
        return;
      }
      if (msg.t === 'welcome') self.clientId = msg.id;
      self.emit(msg.t, msg);
      self.emit('*', msg);
    };

    this.ws.onclose = function () {
      self.connected = false;
      if (self._pingTimer) clearInterval(self._pingTimer);
      self._pingTimer = null;
      self.emit('close', {});
      if (!self.closing) self._scheduleRetry();
    };

    this.ws.onerror = function () { /* onclose follows */ };
  };

  /**
   * Browsers, proxies and sleeping laptops all drop idle sockets, and a dead
   * socket used to swallow everything the player clicked. Reconnect on our
   * own with a backoff instead of waiting for them to reload the page.
   */
  Net.prototype._scheduleRetry = function () {
    if (this._retryTimer || this.closing) return;
    var delay = Math.min(5000, 400 * Math.pow(1.7, this.attempts++));
    var self = this;
    this.emit('reconnecting', { delay: delay, attempt: this.attempts });
    this._retryTimer = setTimeout(function () {
      self._retryTimer = null;
      self.connect();
    }, delay);
  };

  /** Called on user activity: bring the line back up right away. */
  Net.prototype.ensureConnected = function () {
    if (this.connected) return true;
    this.attempts = 0;
    this.connect();
    return false;
  };

  Net.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
      return;
    }
    // Steering input and latency pings are worthless once stale; anything the
    // player deliberately asked for is held and replayed on reconnect.
    if (obj.t !== 'in' && obj.t !== 'ping' && this.queue.length < 20) {
      this.queue.push(JSON.stringify(obj));
    }
    this.ensureConnected();
  };

  global.Net = Net;

  /* ------------------------------------------------------------------ */
  /* Snapshot buffer: keeps the last few server states so the renderer   */
  /* can draw a smoothly interpolated past instead of a jittery present. */
  /* ------------------------------------------------------------------ */

  var DELAY_MS = 90;

  function SnapshotBuffer() {
    this.buf = [];
    this.maxLen = 20;
  }

  SnapshotBuffer.prototype.push = function (snap) {
    snap._recv = performance.now();
    this.buf.push(snap);
    if (this.buf.length > this.maxLen) this.buf.shift();
  };

  SnapshotBuffer.prototype.clear = function () { this.buf.length = 0; };
  SnapshotBuffer.prototype.latest = function () { return this.buf[this.buf.length - 1] || null; };

  /**
   * Returns { a, b, t } - the two snapshots straddling the render time and
   * the blend factor between them. Falls back to the newest when starved.
   */
  SnapshotBuffer.prototype.sample = function () {
    var n = this.buf.length;
    if (n === 0) return null;
    if (n === 1) return { a: this.buf[0], b: this.buf[0], t: 0 };

    var target = performance.now() - DELAY_MS;
    for (var i = n - 1; i > 0; i--) {
      var b = this.buf[i], a = this.buf[i - 1];
      if (a._recv <= target && target <= b._recv) {
        var span = b._recv - a._recv;
        return { a: a, b: b, t: span > 0 ? (target - a._recv) / span : 0 };
      }
    }
    if (target < this.buf[0]._recv) return { a: this.buf[0], b: this.buf[0], t: 0 };
    var last = this.buf[n - 1], prev = this.buf[n - 2];
    return { a: prev, b: last, t: 1 };
  };

  global.SnapshotBuffer = SnapshotBuffer;
})(window);
