/* Minimal RFC 6455 WebSocket server.
 *
 * Deliberately dependency free so Super Sinky runs on a bare Node install:
 * `node server/index.js` and nothing else. Supports text frames, ping/pong
 * keep-alive, fragmentation and close handshakes - which is all the game
 * protocol needs.
 */
'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1 << 20; // 1 MiB hard cap per message

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOp = 0;
    this.isAlive = true;
    this.missedPings = 0;
    this.closeEmitted = false;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', () => this.destroy());
    socket.on('close', () => this._emitClose());
    socket.setTimeout(0);
    socket.setNoDelay(true);
  }

  /* Fires exactly once per connection, however it ended. An abrupt peer
   * disconnect raises 'error' before 'close', so this must not be gated on
   * `open` - otherwise the game never learns the player left. */
  _emitClose() {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.open = false;
    this.emit('close');
  }

  _onData(chunk) {
    // Any traffic at all proves the peer is still there. Relying only on
    // pong frames would drop a client whose stack answers pings lazily.
    this.isAlive = true;
    this.missedPings = 0;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const frame = this._readFrame();
      if (!frame) break;
      this._handleFrame(frame);
      if (!this.open) break;
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;

    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;

    if (len === 126) {
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127) {
      if (b.length < off + 8) return null;
      const big = b.readBigUInt64BE(off); off += 8;
      if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'too large'); return null; }
      len = Number(big);
    }
    if (len > MAX_MESSAGE) { this.close(1009, 'too large'); return null; }

    let maskKey = null;
    if (masked) {
      if (b.length < off + 4) return null;
      maskKey = b.subarray(off, off + 4); off += 4;
    } else {
      // Clients must mask; anything else is a protocol violation.
      this.close(1002, 'unmasked');
      return null;
    }

    if (b.length < off + len) return null;
    const payload = Buffer.from(b.subarray(off, off + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];

    this.buf = b.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame(f) {
    switch (f.opcode) {
      case 0x0: // continuation
        this.fragments.push(f.payload);
        if (f.fin) this._deliver(this.fragmentOp, Buffer.concat(this.fragments));
        break;
      case 0x1: // text
      case 0x2: // binary
        if (f.fin) { this._deliver(f.opcode, f.payload); }
        else { this.fragmentOp = f.opcode; this.fragments = [f.payload]; }
        break;
      case 0x8: // close
        this.close(1000, '');
        break;
      case 0x9: // ping
        this._send(0xA, f.payload);
        break;
      case 0xA: // pong
        this.isAlive = true;
        this.missedPings = 0;
        break;
      default:
        this.close(1002, 'bad opcode');
    }
  }

  _deliver(opcode, payload) {
    this.fragments = [];
    if (opcode === 0x1) this.emit('message', payload.toString('utf8'));
    else this.emit('binary', payload);
  }

  _send(opcode, payload) {
    if (!this.open || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(header);
      if (len) this.socket.write(payload);
    } catch (_) { this.destroy(); }
  }

  send(text) {
    this._send(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this.missedPings = (this.missedPings || 0) + 1;
    this._send(0x9, Buffer.alloc(0));
  }

  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(reason || '', 'utf8');
    const payload = Buffer.allocUnsafe(2 + r.length);
    payload.writeUInt16BE(code || 1000, 0);
    r.copy(payload, 2);
    this._send(0x8, payload);
    this.open = false;
    try { this.socket.end(); } catch (_) {}
    setTimeout(() => this.destroy(), 200).unref();
    this._emitClose();
  }

  destroy() {
    this.open = false;
    try { this.socket.destroy(); } catch (_) {}
    this._emitClose();
  }
}

/** Attach a WebSocket endpoint to an existing http server. */
function attach(httpServer, onConnection) {
  const connections = new Set();

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );

    const conn = new WSConnection(socket);
    conn.remote = req.socket.remoteAddress;
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
    onConnection(conn, req);
  });

  // Drop connections that stop answering pings. Two misses are tolerated:
  // a backgrounded tab can be slow to answer without being gone.
  const beat = setInterval(() => {
    for (const c of connections) {
      if ((c.missedPings || 0) >= 3) { c.destroy(); connections.delete(c); continue; }
      c.ping();
    }
  }, 25000);
  beat.unref();

  return connections;
}

module.exports = { attach, WSConnection };
