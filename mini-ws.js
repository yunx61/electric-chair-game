const crypto = require('crypto');
const { EventEmitter } = require('events');

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = OPEN;
    this.buffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];

    socket.on('data', chunk => this._onData(chunk));
    socket.on('close', () => {
      if (this.readyState !== CLOSED) {
        this.readyState = CLOSED;
        this.emit('close');
      }
    });
    socket.on('error', err => this.emit('error', err));
  }

  send(data) {
    if (this.readyState !== OPEN) return;
    const payload = Buffer.from(String(data));
    this.socket.write(frame(payload, 0x1));
  }

  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    this.readyState = CLOSING;
    const reasonBuf = Buffer.from(String(reason).slice(0, 123));
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try { this.socket.write(frame(payload, 0x8)); } catch {}
    setTimeout(() => this.socket.end(), 30);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const parsed = parseFrame(this.buffer);
      if (!parsed) break;
      this.buffer = this.buffer.subarray(parsed.bytes);
      this._handleFrame(parsed);
    }
  }

  _handleFrame(f) {
    if (f.opcode === 0x8) {
      if (this.readyState === OPEN) {
        try { this.socket.write(frame(f.payload, 0x8)); } catch {}
      }
      this.readyState = CLOSED;
      this.socket.end();
      return;
    }
    if (f.opcode === 0x9) {
      this.socket.write(frame(f.payload, 0xA));
      return;
    }
    if (f.opcode === 0xA) return;

    if (f.opcode === 0x1 || f.opcode === 0x2) {
      if (f.fin) {
        if (f.opcode === 0x1) this.emit('message', f.payload);
      } else {
        this.fragmentOpcode = f.opcode;
        this.fragments = [f.payload];
      }
      return;
    }

    if (f.opcode === 0x0 && this.fragmentOpcode != null) {
      this.fragments.push(f.payload);
      if (f.fin) {
        const full = Buffer.concat(this.fragments);
        const opcode = this.fragmentOpcode;
        this.fragmentOpcode = null;
        this.fragments = [];
        if (opcode === 0x1) this.emit('message', full);
      }
    }
  }
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0];
  const b1 = buf[1];
  const fin = !!(b0 & 0x80);
  const opcode = b0 & 0x0f;
  const masked = !!(b1 & 0x80);
  let len = b1 & 0x7f;
  let offset = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const big = buf.readBigUInt64BE(2);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Frame too large');
    len = Number(big);
    offset = 10;
  }

  let mask;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.subarray(offset, offset + len));
  if (masked) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  }
  return { fin, opcode, payload, bytes: offset + len };
}

function frame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class WebSocketServer extends EventEmitter {
  constructor({ server }) {
    super();
    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      const version = req.headers['sec-websocket-version'];
      if (!key || version !== '13') {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = crypto
        .createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
      socket.setNoDelay(true);
      this.emit('connection', new WSConnection(socket), req);
    });
  }
}

module.exports = {
  WebSocketServer,
  WebSocket: { OPEN, CLOSING, CLOSED }
};
