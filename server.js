const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { version: APP_VERSION } = require('./package.json');

const DEFAULT_PORT = 3000;
const ROOM_TTL_MS = 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 180 * 1000;
const RESULT_DELAY_MS = 5000;
const PERSIST_DEBOUNCE_MS = 250;
const MAX_NAME = 16;
const MAX_WS_PAYLOAD = 16 * 1024;
const MAX_CONNECTIONS_PER_IP = 12;
const MAX_MESSAGES_PER_MINUTE = 120;
const MAX_ROOM_CREATES_PER_MINUTE = 6;
const MAX_JOIN_ATTEMPTS_PER_MINUTE = 30;
const MAX_ROOMS = 1000;
const HEARTBEAT_MS = 30 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const STANDARD_SEATS = Object.freeze(Array.from({ length: 12 }, (_, index) => index + 1));

const AI_PROFILES = Object.freeze({
  rei: { id: 'rei', name: 'レイ', style: '冷徹分析型' },
  gou: { id: 'gou', name: 'ゴウ', style: '豪胆ギャンブラー' },
  mika: { id: 'mika', name: 'ミカ', style: '読心トリックスター' },
  nagi: { id: 'nagi', name: 'ナギ', style: '慎重堅実型' }
});

const DIFFICULTIES = new Set(['easy', 'normal', 'hard']);
const CHALLENGE_RULES = Object.freeze({
  no_shock: { targetScore: 40, shockLimit: 3, seats: STANDARD_SEATS },
  six_turns: { targetScore: 40, shockLimit: 3, seats: STANDARD_SEATS },
  high_risk: { targetScore: 30, shockLimit: 2, seats: [7, 8, 9, 10, 11, 12] },
  sudden: { targetScore: 25, shockLimit: 1, seats: STANDARD_SEATS }
});

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
});

function envNumber(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function equalTokenHash(left, right) {
  if (!/^[a-f0-9]{64}$/.test(left || '') || !/^[a-f0-9]{64}$/.test(right || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function cleanName(value) {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/[<>\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
  return [...(cleaned || 'PLAYER')].slice(0, MAX_NAME).join('');
}

function rulesFor(challengeId) {
  const rules = CHALLENGE_RULES[challengeId];
  return rules
    ? { targetScore: rules.targetScore, shockLimit: rules.shockLimit, seats: [...rules.seats] }
    : { targetScore: 40, shockLimit: 3, seats: [...STANDARD_SEATS] };
}

function createRateLimiter(limit, windowMs = RATE_WINDOW_MS) {
  const buckets = new Map();
  return {
    take(key, now = Date.now()) {
      const current = buckets.get(key);
      if (!current || now - current.startedAt >= windowMs) {
        buckets.set(key, { startedAt: now, count: 1 });
        return true;
      }
      current.count += 1;
      return current.count <= limit;
    },
    prune(now = Date.now()) {
      for (const [key, value] of buckets) {
        if (now - value.startedAt >= windowMs * 2) buckets.delete(key);
      }
    }
  };
}

function createGameServer(options = {}) {
  const publicDir = options.publicDir || path.join(__dirname, 'public');
  const snapshotFile = options.snapshotFile === undefined
    ? path.join(__dirname, '.room-snapshots.json')
    : options.snapshotFile;
  const port = options.port ?? envNumber('PORT', DEFAULT_PORT, 0, 65535);
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';
  const trustProxy = options.trustProxy ?? (Boolean(process.env.RENDER) || process.env.TRUST_PROXY === 'true');
  const allowMissingOrigin = options.allowMissingOrigin ?? !isProduction;
  const configuredOrigins = options.allowedOrigins || String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const allowedOrigins = new Set(configuredOrigins);
  const maxRooms = options.maxRooms ?? envNumber('MAX_ROOMS', MAX_ROOMS, 10, 10000);

  const rooms = new Map();
  const timers = new Set();
  const connectionsByIp = new Map();
  const messageLimiter = createRateLimiter(MAX_MESSAGES_PER_MINUTE);
  const roomCreateLimiter = createRateLimiter(MAX_ROOM_CREATES_PER_MINUTE);
  const joinLimiter = createRateLimiter(MAX_JOIN_ATTEMPTS_PER_MINUTE);
  let cleanupInterval = null;
  let heartbeatInterval = null;
  let persistTimer = null;
  let persistChain = Promise.resolve();
  let started = false;
  let stopping = false;

  function later(callback, delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timers.add(timer);
    return timer;
  }

  function connectionIp(req) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) return forwarded;
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function requestHost(req) {
    if (trustProxy) {
      const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
      if (forwarded) return forwarded.toLowerCase();
    }
    return String(req.headers.host || '').toLowerCase();
  }

  function originAllowed(req) {
    const origin = String(req.headers.origin || '').trim();
    if (!origin) return allowMissingOrigin;
    if (allowedOrigins.has(origin)) return true;
    try {
      const parsed = new URL(origin);
      return ['http:', 'https:'].includes(parsed.protocol) && parsed.host.toLowerCase() === requestHost(req);
    } catch {
      return false;
    }
  }

  function rejectUpgrade(socket, statusCode, statusText) {
    if (!socket.writable) return socket.destroy();
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(statusText)}\r\n\r\n` +
      statusText
    );
  }

  function setSecurityHeaders(req, res) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'");
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    const forwardedProto = trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    if (req.socket.encrypted || forwardedProto === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  }

  function cacheControlFor(filePath) {
    const fileName = path.basename(filePath);
    if (fileName === 'index.html') return 'no-store';
    if (fileName === 'service-worker.js') return 'no-cache';
    return 'public, max-age=3600, must-revalidate';
  }

  const server = http.createServer((req, res) => {
    setSecurityHeaders(req, res);
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(method === 'HEAD' ? undefined : 'Method Not Allowed');
    }

    const rawPath = String(req.url || '/').split('?')[0];
    let urlPath;
    try {
      urlPath = decodeURIComponent(rawPath);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(method === 'HEAD' ? undefined : 'Bad Request');
    }

    if (urlPath.includes('\0')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(method === 'HEAD' ? undefined : 'Bad Request');
    }

    if (urlPath === '/health') {
      const body = Buffer.from(JSON.stringify({ ok: true }));
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': body.length
      });
      return res.end(method === 'HEAD' ? undefined : body);
    }

    const requested = urlPath === '/' ? '/index.html' : urlPath;
    const resolved = path.resolve(publicDir, `.${requested}`);
    const root = `${path.resolve(publicDir)}${path.sep}`;
    if (resolved !== path.resolve(publicDir, 'index.html') && !resolved.startsWith(root)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(method === 'HEAD' ? undefined : 'Forbidden');
    }

    fs.readFile(resolved, (error, data) => {
      if (error) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(method === 'HEAD' ? undefined : 'Not Found');
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
        'Cache-Control': cacheControlFor(resolved),
        'Content-Length': data.length
      });
      return res.end(method === 'HEAD' ? undefined : data);
    });
  });

  server.on('clientError', (_error, socket) => rejectUpgrade(socket, 400, 'Bad Request'));
  server.on('error', error => console.error('http server error', error.message));

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    maxPayload: MAX_WS_PAYLOAD,
    perMessageDeflate: false
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', error => console.warn('upgrade socket error', error.message));
    let pathname;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (pathname !== '/') return rejectUpgrade(socket, 404, 'Not Found');
    if (!originAllowed(req)) return rejectUpgrade(socket, 403, 'Forbidden');

    const ip = connectionIp(req);
    const active = connectionsByIp.get(ip) || 0;
    if (active >= MAX_CONNECTIONS_PER_IP) return rejectUpgrade(socket, 429, 'Too Many Requests');
    connectionsByIp.set(ip, active + 1);

    try {
      wss.handleUpgrade(req, socket, head, ws => {
        ws.clientIp = ip;
        ws.connectionCounted = true;
        wss.emit('connection', ws, req);
      });
    } catch (error) {
      connectionsByIp.set(ip, Math.max(0, (connectionsByIp.get(ip) || 1) - 1));
      console.warn('websocket upgrade failed', error.message);
      socket.destroy();
    }
  });

  function schedulePersist() {
    if (!snapshotFile || stopping || persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistChain = persistChain.then(writeSnapshot);
    }, PERSIST_DEBOUNCE_MS);
  }

  function serializableRooms() {
    return [...rooms.entries()].map(([code, room]) => [code, {
      ...room,
      players: room.players.map(player => player ? { ...player, ws: null } : null)
    }]);
  }

  async function writeSnapshot() {
    if (!snapshotFile) return;
    const tempFile = `${snapshotFile}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.mkdir(path.dirname(snapshotFile), { recursive: true });
      await fsp.writeFile(tempFile, JSON.stringify(serializableRooms()), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tempFile, snapshotFile);
    } catch (error) {
      console.warn('snapshot write failed', error.message);
      await fsp.rm(tempFile, { force: true }).catch(() => {});
    }
  }

  async function flushRooms() {
    if (!snapshotFile) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    persistChain = persistChain.then(writeSnapshot);
    await persistChain;
  }

  function validSeats(value) {
    return Array.isArray(value)
      && value.length > 0
      && value.every(seat => Number.isInteger(seat) && seat >= 1 && seat <= 12)
      && new Set(value).size === value.length;
  }

  function restorePlayer(player, now) {
    if (!player || typeof player !== 'object') return null;
    const storedHash = /^[a-f0-9]{64}$/.test(player.tokenHash || '')
      ? player.tokenHash
      : (/^[a-f0-9]{48}$/.test(player.token || '') ? tokenHash(player.token) : null);
    if (!storedHash) return null;
    return {
      id: String(player.id || crypto.randomUUID()),
      tokenHash: storedHash,
      name: cleanName(player.name),
      score: Number.isFinite(player.score) ? player.score : 0,
      shocks: Number.isFinite(player.shocks) ? player.shocks : 0,
      wins: Number.isFinite(player.wins) ? player.wins : 0,
      ws: null,
      connected: Boolean(player.isAI),
      disconnectedAt: player.isAI ? null : now,
      isAI: Boolean(player.isAI)
    };
  }

  async function restoreRooms() {
    if (!snapshotFile) return;
    try {
      const raw = await fsp.readFile(snapshotFile, 'utf8');
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) throw new Error('snapshot root must be an array');
      const now = Date.now();
      for (const entry of data) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [code, stored] = entry;
        if (!/^\d{6}$/.test(String(code)) || !stored || now - Number(stored.updatedAt || 0) > ROOM_TTL_MS) continue;
        const rules = stored.rules && validSeats(stored.rules.seats)
          ? {
              targetScore: Number(stored.rules.targetScore) || 40,
              shockLimit: Number(stored.rules.shockLimit) || 3,
              seats: [...stored.rules.seats]
            }
          : rulesFor(stored.challengeId);
        const players = Array.isArray(stored.players)
          ? [restorePlayer(stored.players[0], now), restorePlayer(stored.players[1], now)]
          : [null, null];
        if (!players[0]) continue;
        const remainingSeats = validSeats(stored.remainingSeats) ? [...stored.remainingSeats] : [...rules.seats];
        const room = {
          ...stored,
          code: String(code),
          rules,
          players,
          remainingSeats,
          trapSeat: Number.isInteger(stored.trapSeat) ? stored.trapSeat : null,
          rematchVotes: Array.isArray(stored.rematchVotes) ? stored.rematchVotes.slice(0, 2).map(Boolean) : [false, false],
          history: stored.history || { traps: [[], []], sits: [[], []], outcomes: [[], []] },
          updatedAt: Number(stored.updatedAt) || now
        };
        rooms.set(room.code, room);
      }
      if (rooms.size) console.log(`Restored ${rooms.size} room(s)`);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('snapshot restore failed', error.message);
    }
  }

  function makeCode() {
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const code = String(crypto.randomInt(100000, 1000000));
      if (!rooms.has(code)) return code;
    }
    throw new Error('Room code exhaustion');
  }

  function newPlayer(name, extra = {}) {
    const token = crypto.randomBytes(24).toString('hex');
    return {
      token,
      player: {
        id: crypto.randomUUID(),
        tokenHash: tokenHash(token),
        name: cleanName(name),
        score: 0,
        shocks: 0,
        wins: 0,
        ws: null,
        connected: false,
        disconnectedAt: null,
        isAI: false,
        ...extra
      }
    };
  }

  function newRoom(hostName, mode = 'human', challengeId = null) {
    const code = makeCode();
    const { player: host, token } = newPlayer(hostName);
    const rules = rulesFor(challengeId);
    const now = Date.now();
    const room = {
      code,
      mode,
      challengeId: challengeId || null,
      rules,
      players: [host, null],
      phase: 'waiting',
      setterIndex: null,
      sitterIndex: null,
      trapSeat: null,
      remainingSeats: [...rules.seats],
      turnNumber: 0,
      lastResult: null,
      winnerIndex: null,
      endReason: null,
      pendingEnd: null,
      resultDueAt: null,
      rematchVotes: [false, false],
      gameNumber: 0,
      createdAt: now,
      updatedAt: now,
      aiProfile: null,
      aiDifficulty: null,
      history: { traps: [[], []], sits: [[], []], outcomes: [[], []] }
    };
    rooms.set(code, room);
    return { room, player: host, token, index: 0 };
  }

  function publicPlayer(player) {
    return player ? {
      name: player.name,
      score: player.score,
      shocks: player.shocks,
      wins: player.wins,
      connected: player.connected,
      isAI: Boolean(player.isAI)
    } : null;
  }

  function publicAI(room) {
    if (!room.aiProfile) return null;
    const profile = AI_PROFILES[room.aiProfile] || AI_PROFILES.rei;
    return { ...profile, difficulty: room.aiDifficulty };
  }

  function viewFor(room, viewerIndex) {
    return {
      code: room.code,
      you: viewerIndex,
      mode: room.mode,
      challengeId: room.challengeId,
      rules: {
        targetScore: room.rules.targetScore,
        shockLimit: room.rules.shockLimit,
        seats: room.rules.seats
      },
      phase: room.phase,
      players: room.players.map(publicPlayer),
      setterIndex: room.setterIndex,
      sitterIndex: room.sitterIndex,
      remainingSeats: room.remainingSeats,
      turnNumber: room.turnNumber,
      gameNumber: room.gameNumber,
      lastResult: room.phase === 'result' ? room.lastResult : null,
      winnerIndex: room.winnerIndex,
      endReason: room.endReason,
      rematchVotes: room.rematchVotes,
      ai: publicAI(room),
      canSetTrap: room.phase === 'set_trap' && viewerIndex === room.setterIndex,
      canChooseSeat: room.phase === 'choose_seat' && viewerIndex === room.sitterIndex
    };
  }

  function send(ws, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      console.warn('websocket send failed', error.message);
      return false;
    }
  }

  function fail(ws, message, code = 'INVALID_ACTION') {
    send(ws, { type: 'error', code, message });
  }

  function broadcastState(room) {
    room.updatedAt = Date.now();
    room.players.forEach((player, index) => {
      if (player?.ws) send(player.ws, { type: 'state', state: viewFor(room, index) });
    });
    schedulePersist();
  }

  function startGame(room) {
    if (!room.players[0] || !room.players[1]) return;
    room.players.forEach(player => {
      player.score = 0;
      player.shocks = 0;
    });
    room.remainingSeats = [...room.rules.seats];
    room.turnNumber = 1;
    room.gameNumber += 1;
    room.trapSeat = null;
    room.lastResult = null;
    room.winnerIndex = null;
    room.endReason = null;
    room.pendingEnd = null;
    room.resultDueAt = null;
    room.rematchVotes = [false, false];
    room.history = { traps: [[], []], sits: [[], []], outcomes: [[], []] };
    room.setterIndex = crypto.randomInt(0, 2);
    room.sitterIndex = 1 - room.setterIndex;
    room.phase = 'set_trap';
    broadcastState(room);
    scheduleAI(room);
  }

  function endGame(room, winnerIndex, reason) {
    if (room.phase === 'game_over') return;
    room.phase = 'game_over';
    room.winnerIndex = winnerIndex;
    room.endReason = reason;
    room.trapSeat = null;
    room.pendingEnd = null;
    room.resultDueAt = null;
    room.rematchVotes = [false, false];
    if (winnerIndex != null && room.players[winnerIndex]) room.players[winnerIndex].wins += 1;
    broadcastState(room);
  }

  function getEndOutcome(room, actorIndex) {
    const actor = room.players[actorIndex];
    const opponentIndex = 1 - actorIndex;
    if (actor.shocks >= room.rules.shockLimit) return { winnerIndex: opponentIndex, reason: 'shock_limit' };
    if (actor.score >= room.rules.targetScore) return { winnerIndex: actorIndex, reason: 'target_score' };
    if (room.remainingSeats.length <= 1) {
      const [first, second] = room.players;
      return {
        winnerIndex: first.score === second.score ? null : (first.score > second.score ? 0 : 1),
        reason: 'one_seat_left'
      };
    }
    return null;
  }

  function nextTurn(room) {
    const oldSetter = room.setterIndex;
    room.setterIndex = room.sitterIndex;
    room.sitterIndex = oldSetter;
    room.trapSeat = null;
    room.lastResult = null;
    room.pendingEnd = null;
    room.resultDueAt = null;
    room.phase = 'set_trap';
    room.turnNumber += 1;
    broadcastState(room);
    scheduleAI(room);
  }

  function findByToken(room, token) {
    if (!/^[a-f0-9]{48}$/.test(token || '')) return null;
    const candidate = tokenHash(token);
    const index = room.players.findIndex(player => player && equalTokenHash(player.tokenHash, candidate));
    return index >= 0 ? { player: room.players[index], index } : null;
  }

  function attach(ws, room, player, index, token) {
    if (player.ws && player.ws !== ws && player.ws.readyState === WebSocket.OPEN) {
      player.ws.close(4001, 'Signed in elsewhere');
    }
    player.ws = ws;
    player.connected = true;
    player.disconnectedAt = null;
    ws.session = { roomCode: room.code, playerToken: token, playerIndex: index };
    send(ws, { type: 'session', roomCode: room.code, playerToken: token, playerIndex: index });
    broadcastState(room);
    scheduleAI(room);
  }

  function weightedPick(items, scoreFn) {
    const scores = items.map(item => Math.max(0.001, scoreFn(item)));
    const total = scores.reduce((sum, score) => sum + score, 0);
    let random = Math.random() * total;
    for (let index = 0; index < items.length; index += 1) {
      random -= scores[index];
      if (random <= 0) return items[index];
    }
    return items.at(-1);
  }

  const frequency = (items, value) => items.filter(item => item === value).length;
  function recency(items, value) {
    let score = 0;
    items.slice(-6).forEach((item, index) => {
      if (item === value) score += index + 1;
    });
    return score;
  }

  function humanSeatTendency(room, seat) {
    const sits = room.history.sits[0];
    const human = room.players[0];
    let tendency = frequency(sits, seat) * 1.05 + recency(sits, seat) * 0.34 + seat * 0.05;
    if (human.score >= Math.max(18, room.rules.targetScore - 15) && human.score + seat >= room.rules.targetScore) tendency += 2.5;
    if (human.shocks >= room.rules.shockLimit - 1 && seat <= 6) tendency += 1.25;
    if (sits.length >= 2 && sits.at(-1) > 8 && seat > 8) tendency += 0.45;
    return tendency;
  }

  function aiTrapChoice(room) {
    const seats = room.remainingSeats;
    const profile = room.aiProfile;
    const difficulty = room.aiDifficulty;
    const humanSits = room.history.sits[0];
    if (difficulty === 'easy') return seats[crypto.randomInt(0, seats.length)];
    return weightedPick(seats, seat => {
      let score = 1 + seat * 0.18;
      const observed = frequency(humanSits, seat) + (difficulty === 'hard' ? recency(humanSits, seat) * 0.55 : 0);
      score += observed * (difficulty === 'hard' ? 2.2 : 1.05);
      if (difficulty === 'hard') score += humanSeatTendency(room, seat) * 1.45;
      if (profile === 'gou') score += seat >= 9 ? 3.5 : seat * 0.08;
      if (profile === 'nagi') score += seat >= 7 && seat <= 10 ? 1.7 : (seat >= 11 ? 0.7 : 0);
      if (profile === 'mika') score += ((seat + room.turnNumber) % 3 === 0 ? 1.5 : 0) + Math.random() * 2.2;
      if (profile === 'rei') score += seat * 0.16 + observed * 1.2;
      return score;
    });
  }

  function estimatedHumanTrapProbability(room, seat) {
    const traps = room.history.traps[0];
    const human = room.players[0];
    let base = 0.42 + seat * 0.052 + frequency(traps, seat) * 0.82 + recency(traps, seat) * 0.26;
    if (human.score >= Math.max(18, room.rules.targetScore - 16) && seat >= 9) base += 0.55;
    if (human.shocks >= room.rules.shockLimit - 1 && seat <= 6) base += 0.18;
    return base;
  }

  function aiSeatChoice(room) {
    const seats = room.remainingSeats;
    const profile = room.aiProfile;
    const difficulty = room.aiDifficulty;
    const ai = room.players[1];
    if (difficulty === 'easy') return seats[crypto.randomInt(0, seats.length)];
    return weightedPick(seats, seat => {
      const risk = estimatedHumanTrapProbability(room, seat);
      let score = 1;
      if (profile === 'gou') score = Math.pow(seat, 1.55) / (1 + risk * (difficulty === 'hard' ? 0.35 : 0.18));
      else if (profile === 'nagi') score = (seat * 0.9 + 4) / (1 + risk * (difficulty === 'hard' ? 2.3 : 1.4) + (ai.score > room.rules.targetScore / 2 ? 1.2 : 0));
      else if (profile === 'mika') score = (seat * 1.15 + Math.random() * 8) / (1 + risk * (difficulty === 'hard' ? 1.25 : 0.7));
      else score = (seat * 1.35 + 2) / (1 + risk * (difficulty === 'hard' ? 1.8 : 0.9));
      if (ai.shocks >= room.rules.shockLimit - 1) score /= 1 + risk * 1.8;
      if (ai.score + seat >= room.rules.targetScore) score *= 1.75;
      return Math.max(0.01, score);
    });
  }

  function finishResult(room) {
    if (rooms.get(room.code) !== room || room.phase !== 'result') return;
    const pending = room.pendingEnd;
    room.pendingEnd = null;
    room.resultDueAt = null;
    if (pending) endGame(room, pending.winnerIndex, pending.reason);
    else nextTurn(room);
  }

  function applySeatChoice(room, index, seat) {
    const shocked = seat === room.trapSeat;
    const sitter = room.players[index];
    const before = sitter.score;
    room.history.sits[index].push(seat);
    if (shocked) {
      sitter.score = 0;
      sitter.shocks += 1;
    } else {
      sitter.score += seat;
      room.remainingSeats = room.remainingSeats.filter(value => value !== seat);
    }
    room.history.outcomes[index].push({ seat, shocked, scoreBefore: before, scoreAfter: sitter.score });
    room.lastResult = {
      seat,
      trapSeat: room.trapSeat,
      shocked,
      playerIndex: index,
      pointsBefore: before,
      pointsAfter: sitter.score,
      gained: shocked ? 0 : seat
    };
    room.trapSeat = null;
    room.phase = 'result';
    room.pendingEnd = getEndOutcome(room, index);
    room.resultDueAt = Date.now() + RESULT_DELAY_MS;
    broadcastState(room);
    later(() => finishResult(room), RESULT_DELAY_MS);
  }

  function scheduleAI(room) {
    if (room.mode !== 'ai' || room.phase === 'game_over') return;
    const delay = room.aiDifficulty === 'hard' ? 650 : (room.aiDifficulty === 'normal' ? 900 : 1150);
    if (room.phase === 'set_trap' && room.setterIndex === 1) {
      later(() => {
        if (rooms.get(room.code) !== room || room.phase !== 'set_trap' || room.setterIndex !== 1) return;
        const seat = aiTrapChoice(room);
        room.trapSeat = seat;
        room.history.traps[1].push(seat);
        room.phase = 'choose_seat';
        room.lastResult = null;
        broadcastState(room);
        scheduleAI(room);
      }, delay + crypto.randomInt(150, 650));
    }
    if (room.phase === 'choose_seat' && room.sitterIndex === 1) {
      later(() => {
        if (rooms.get(room.code) !== room || room.phase !== 'choose_seat' || room.sitterIndex !== 1) return;
        applySeatChoice(room, 1, aiSeatChoice(room));
      }, delay + crypto.randomInt(250, 900));
    }
  }

  function currentSession(ws) {
    const session = ws.session;
    if (!session) return null;
    const room = rooms.get(session.roomCode);
    if (!room) return null;
    const found = findByToken(room, session.playerToken);
    if (!found) return null;
    return { room, ...found };
  }

  function handleMessage(ws, raw, isBinary) {
    if (isBinary) {
      fail(ws, 'テキスト形式で送信してください', 'BINARY_NOT_ALLOWED');
      return;
    }
    if (!messageLimiter.take(ws.clientIp)) {
      fail(ws, '操作が多すぎます。少し待ってください', 'RATE_LIMITED');
      ws.close(1008, 'Rate limit exceeded');
      return;
    }

    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      fail(ws, '不正なデータです', 'INVALID_JSON');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
      fail(ws, '不正なデータです', 'INVALID_MESSAGE');
      return;
    }

    try {
      if (message.type === 'ping') {
        send(ws, { type: 'pong', ts: Date.now() });
        return;
      }

      if (message.type === 'create_room' || message.type === 'create_ai_room') {
        if (ws.session) return fail(ws, '先に現在の対戦から退出してください', 'ALREADY_IN_ROOM');
        if (!roomCreateLimiter.take(ws.clientIp)) return fail(ws, 'ルーム作成が多すぎます。少し待ってください', 'RATE_LIMITED');
        if (rooms.size >= maxRooms) return fail(ws, '現在ルームを作成できません', 'ROOM_LIMIT_REACHED');
      }

      if (message.type === 'create_room') {
        const { room, player, token, index } = newRoom(message.name, 'human');
        attach(ws, room, player, index, token);
        return;
      }

      if (message.type === 'create_ai_room') {
        const profile = AI_PROFILES[message.aiId] || AI_PROFILES.rei;
        const difficulty = DIFFICULTIES.has(message.difficulty) ? message.difficulty : 'normal';
        const challengeId = Object.hasOwn(CHALLENGE_RULES, message.challengeId) ? message.challengeId : null;
        const { room, player, token, index } = newRoom(message.name, 'ai', challengeId);
        room.aiProfile = profile.id;
        room.aiDifficulty = difficulty;
        room.players[1] = newPlayer(profile.name, { isAI: true, connected: true }).player;
        attach(ws, room, player, index, token);
        startGame(room);
        return;
      }

      if (message.type === 'join_room') {
        if (ws.session) return fail(ws, '先に現在の対戦から退出してください', 'ALREADY_IN_ROOM');
        if (!joinLimiter.take(ws.clientIp)) return fail(ws, '参加試行が多すぎます。少し待ってください', 'RATE_LIMITED');
        const code = String(message.code || '').trim();
        if (!/^\d{6}$/.test(code)) return fail(ws, '6桁のルームIDを入力してください', 'INVALID_ROOM_CODE');
        const room = rooms.get(code);
        if (!room || room.mode === 'ai' || room.players[1]) return fail(ws, '参加できるルームが見つかりません', 'ROOM_UNAVAILABLE');
        const { player, token } = newPlayer(message.name);
        room.players[1] = player;
        attach(ws, room, player, 1, token);
        startGame(room);
        return;
      }

      if (message.type === 'resume') {
        if (ws.session) return fail(ws, 'すでに対戦へ接続しています', 'ALREADY_IN_ROOM');
        const code = String(message.code || '').trim();
        const token = String(message.token || '').trim();
        if (!/^\d{6}$/.test(code) || !/^[a-f0-9]{48}$/.test(token)) return fail(ws, '再接続情報が一致しません', 'INVALID_SESSION');
        const room = rooms.get(code);
        if (!room) return fail(ws, '再接続するルームがありません', 'SESSION_NOT_FOUND');
        const found = findByToken(room, token);
        if (!found) return fail(ws, '再接続情報が一致しません', 'INVALID_SESSION');
        attach(ws, room, found.player, found.index, token);
        return;
      }

      const session = currentSession(ws);
      if (!session) {
        ws.session = null;
        send(ws, { type: 'session_required' });
        return;
      }
      const { room, player, index } = session;

      if (message.type === 'set_trap') {
        if (room.phase !== 'set_trap' || index !== room.setterIndex) return fail(ws, '今は電気イスを設定できません');
        const seat = Number(message.seat);
        if (!Number.isInteger(seat) || !room.remainingSeats.includes(seat)) return fail(ws, 'そのイスは選べません');
        room.trapSeat = seat;
        room.history.traps[index].push(seat);
        room.phase = 'choose_seat';
        room.lastResult = null;
        broadcastState(room);
        scheduleAI(room);
        return;
      }

      if (message.type === 'choose_seat') {
        if (room.phase !== 'choose_seat' || index !== room.sitterIndex) return fail(ws, '今は着席できません');
        const seat = Number(message.seat);
        if (!Number.isInteger(seat) || !room.remainingSeats.includes(seat)) return fail(ws, 'そのイスは選べません');
        applySeatChoice(room, index, seat);
        return;
      }

      if (message.type === 'rematch_vote') {
        if (room.phase !== 'game_over') return fail(ws, 'ゲーム終了後に使えます');
        if (room.mode === 'ai') {
          room.rematchVotes = [true, true];
          startGame(room);
          return;
        }
        room.rematchVotes[index] = true;
        if (room.rematchVotes[0] && room.rematchVotes[1]) startGame(room);
        else broadcastState(room);
        return;
      }

      if (message.type === 'leave') {
        const opponent = 1 - index;
        if (room.mode === 'human' && room.phase !== 'waiting' && room.phase !== 'game_over' && room.players[opponent]) {
          endGame(room, opponent, 'opponent_left');
        }
        player.connected = false;
        player.ws = null;
        player.disconnectedAt = Date.now();
        ws.session = null;
        send(ws, { type: 'left' });
        if (room.mode === 'ai' || room.phase === 'waiting') {
          rooms.delete(room.code);
          schedulePersist();
        } else {
          broadcastState(room);
        }
        return;
      }

      fail(ws, '未対応の操作です', 'UNKNOWN_ACTION');
    } catch (error) {
      console.error('message handling failed', error);
      fail(ws, 'サーバー内部でエラーが発生しました', 'INTERNAL_ERROR');
    }
  }

  wss.on('connection', ws => {
    ws.isAlive = true;
    send(ws, { type: 'hello', serverTime: Date.now(), version: APP_VERSION });
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (raw, isBinary) => handleMessage(ws, raw, isBinary));
    ws.on('error', error => console.warn('websocket connection error', error.message));
    ws.on('close', () => {
      if (ws.connectionCounted) {
        const current = connectionsByIp.get(ws.clientIp) || 1;
        if (current <= 1) connectionsByIp.delete(ws.clientIp);
        else connectionsByIp.set(ws.clientIp, current - 1);
        ws.connectionCounted = false;
      }
      const session = currentSession(ws);
      if (!session || session.player.ws !== ws) return;
      session.player.ws = null;
      session.player.connected = false;
      session.player.disconnectedAt = Date.now();
      broadcastState(session.room);
    });
  });
  wss.on('error', error => console.error('websocket server error', error.message));

  function cleanup() {
    const now = Date.now();
    let changed = false;
    for (const [code, room] of rooms) {
      if (room.mode === 'human' && !['waiting', 'game_over'].includes(room.phase)) {
        const timedOut = room.players
          .map((player, index) => ({ player, index }))
          .filter(({ player }) => player && !player.isAI && !player.connected && player.disconnectedAt && now - player.disconnectedAt > RECONNECT_GRACE_MS);
        if (timedOut.length === 2) endGame(room, null, 'both_disconnected');
        else if (timedOut.length === 1 && room.players[1 - timedOut[0].index]) endGame(room, 1 - timedOut[0].index, 'disconnect_timeout');
      }
      const waitingExpired = room.phase === 'waiting'
        && room.players.every(player => !player || player.isAI || (!player.connected && player.disconnectedAt && now - player.disconnectedAt > RECONNECT_GRACE_MS));
      if (waitingExpired || now - room.updatedAt > ROOM_TTL_MS) {
        rooms.delete(code);
        changed = true;
      }
    }
    if (changed) schedulePersist();
    messageLimiter.prune(now);
    roomCreateLimiter.prune(now);
    joinLimiter.prune(now);
  }

  function heartbeat() {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (error) {
        console.warn('websocket ping failed', error.message);
        ws.terminate();
      }
    }
  }

  async function start() {
    if (started) return server.address();
    await restoreRooms();
    for (const room of rooms.values()) {
      if (room.phase === 'result') {
        const delay = Math.max(0, Number(room.resultDueAt || Date.now()) - Date.now());
        later(() => finishResult(room), delay);
      } else {
        scheduleAI(room);
      }
    }
    cleanupInterval = setInterval(cleanup, 5000);
    heartbeatInterval = setInterval(heartbeat, HEARTBEAT_MS);
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '0.0.0.0');
    });
    started = true;
    const address = server.address();
    console.log(`Electric Chair Duel v${APP_VERSION} listening on http://localhost:${address.port}`);
    return address;
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    if (cleanupInterval) clearInterval(cleanupInterval);
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await flushRooms();
    for (const ws of wss.clients) ws.terminate();
    if (started) {
      await new Promise(resolve => server.close(() => resolve()));
    }
    started = false;
  }

  return { server, wss, rooms, start, stop, flushRooms };
}

if (require.main === module) {
  const app = createGameServer();
  app.start().catch(error => {
    console.error('server start failed', error);
    process.exitCode = 1;
  });
  const shutdown = signal => {
    console.log(`${signal} received; shutting down`);
    app.stop().finally(() => process.exit());
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

module.exports = { createGameServer, cleanName, tokenHash };
