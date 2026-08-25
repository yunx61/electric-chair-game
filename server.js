const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('./mini-ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_TTL_MS = 60 * 60 * 1000;
const RECONNECT_GRACE_MS = 90 * 1000;
const MAX_NAME = 16;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, ts: Date.now() }));
    return;
  }

  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const resolved = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

function cleanName(value) {
  const s = String(value || '').trim().replace(/[<>]/g, '');
  return (s || 'PLAYER').slice(0, MAX_NAME);
}

function makeCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(crypto.randomInt(100000, 1000000));
    if (!rooms.has(code)) return code;
  }
  throw new Error('Room code exhaustion');
}

function newPlayer(name) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString('hex'),
    name: cleanName(name),
    score: 0,
    shocks: 0,
    wins: 0,
    ws: null,
    connected: false,
    disconnectedAt: null
  };
}

function newRoom(hostName) {
  const code = makeCode();
  const host = newPlayer(hostName);
  const room = {
    code,
    players: [host, null],
    phase: 'waiting',
    setterIndex: null,
    sitterIndex: null,
    trapSeat: null,
    remainingSeats: Array.from({ length: 12 }, (_, i) => i + 1),
    turnNumber: 0,
    lastResult: null,
    winnerIndex: null,
    endReason: null,
    rematchVotes: [false, false],
    gameNumber: 0,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  return { room, player: host, index: 0 };
}

function publicPlayer(p) {
  return p ? {
    name: p.name,
    score: p.score,
    shocks: p.shocks,
    wins: p.wins,
    connected: p.connected
  } : null;
}

function viewFor(room, viewerIndex) {
  return {
    code: room.code,
    you: viewerIndex,
    phase: room.phase,
    players: room.players.map(publicPlayer),
    setterIndex: room.setterIndex,
    sitterIndex: room.sitterIndex,
    remainingSeats: room.remainingSeats,
    turnNumber: room.turnNumber,
    gameNumber: room.gameNumber,
    lastResult: room.lastResult,
    winnerIndex: room.winnerIndex,
    endReason: room.endReason,
    rematchVotes: room.rematchVotes,
    canSetTrap: room.phase === 'set_trap' && viewerIndex === room.setterIndex,
    canChooseSeat: room.phase === 'choose_seat' && viewerIndex === room.sitterIndex
    // trapSeat intentionally omitted while active.
  };
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastState(room) {
  room.updatedAt = Date.now();
  room.players.forEach((p, i) => {
    if (p?.ws) send(p.ws, { type: 'state', state: viewFor(room, i) });
  });
}

function fail(ws, message) {
  send(ws, { type: 'error', message });
}

function startGame(room) {
  room.players.forEach(p => {
    p.score = 0;
    p.shocks = 0;
  });
  room.remainingSeats = Array.from({ length: 12 }, (_, i) => i + 1);
  room.turnNumber = 1;
  room.gameNumber += 1;
  room.trapSeat = null;
  room.lastResult = null;
  room.winnerIndex = null;
  room.endReason = null;
  room.rematchVotes = [false, false];
  room.setterIndex = crypto.randomInt(0, 2);
  room.sitterIndex = 1 - room.setterIndex;
  room.phase = 'set_trap';
  broadcastState(room);
}

function endGame(room, winnerIndex, reason) {
  if (room.phase === 'game_over') return;
  room.phase = 'game_over';
  room.winnerIndex = winnerIndex;
  room.endReason = reason;
  room.trapSeat = null;
  room.rematchVotes = [false, false];
  if (winnerIndex != null && room.players[winnerIndex]) room.players[winnerIndex].wins += 1;
  broadcastState(room);
}

function checkEnd(room, actorIndex) {
  const actor = room.players[actorIndex];
  const opponentIndex = 1 - actorIndex;
  if (actor.shocks >= 3) {
    endGame(room, opponentIndex, 'three_shocks');
    return true;
  }
  if (actor.score >= 40) {
    endGame(room, actorIndex, 'forty_points');
    return true;
  }
  if (room.remainingSeats.length <= 1) {
    const [a, b] = room.players;
    const winner = a.score === b.score ? null : (a.score > b.score ? 0 : 1);
    endGame(room, winner, 'one_seat_left');
    return true;
  }
  return false;
}

function nextTurn(room) {
  const oldSetter = room.setterIndex;
  room.setterIndex = room.sitterIndex;
  room.sitterIndex = oldSetter;
  room.trapSeat = null;
  room.phase = 'set_trap';
  room.turnNumber += 1;
  broadcastState(room);
}

function findByToken(room, token) {
  const index = room.players.findIndex(p => p && p.token === token);
  return index >= 0 ? { player: room.players[index], index } : null;
}

function attach(ws, room, player, index) {
  if (player.ws && player.ws !== ws && player.ws.readyState === WebSocket.OPEN) {
    player.ws.close(4001, 'Signed in elsewhere');
  }
  player.ws = ws;
  player.connected = true;
  player.disconnectedAt = null;
  ws.session = { roomCode: room.code, playerToken: player.token, playerIndex: index };
  send(ws, { type: 'session', roomCode: room.code, playerToken: player.token, playerIndex: index });
  broadcastState(room);
}

wss.on('connection', (ws) => {
  send(ws, { type: 'hello', serverTime: Date.now() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return fail(ws, '不正なデータです'); }

    try {
      if (msg.type === 'ping') {
        send(ws, { type: 'pong', ts: Date.now() });
        return;
      }

      if (msg.type === 'create_room') {
        const { room, player, index } = newRoom(msg.name);
        attach(ws, room, player, index);
        return;
      }

      if (msg.type === 'join_room') {
        const code = String(msg.code || '').replace(/\D/g, '').slice(0, 6);
        const room = rooms.get(code);
        if (!room) return fail(ws, 'ルームが見つかりません');
        if (room.players[1]) return fail(ws, 'このルームは満員です');
        const player = newPlayer(msg.name);
        room.players[1] = player;
        attach(ws, room, player, 1);
        startGame(room);
        return;
      }

      if (msg.type === 'resume') {
        const code = String(msg.code || '');
        const room = rooms.get(code);
        if (!room) return fail(ws, '再接続するルームがありません');
        const found = findByToken(room, String(msg.token || ''));
        if (!found) return fail(ws, '再接続情報が一致しません');
        attach(ws, room, found.player, found.index);
        return;
      }

      const s = ws.session;
      if (!s) return fail(ws, '先にルームへ参加してください');
      const room = rooms.get(s.roomCode);
      if (!room) return fail(ws, 'ルームが終了しています');
      const found = findByToken(room, s.playerToken);
      if (!found) return fail(ws, 'セッションが無効です');
      const idx = found.index;

      if (msg.type === 'set_trap') {
        if (room.phase !== 'set_trap' || idx !== room.setterIndex) return fail(ws, '今は電気イスを設定できません');
        const seat = Number(msg.seat);
        if (!room.remainingSeats.includes(seat)) return fail(ws, 'そのイスは選べません');
        room.trapSeat = seat;
        room.phase = 'choose_seat';
        room.lastResult = null;
        broadcastState(room);
        return;
      }

      if (msg.type === 'choose_seat') {
        if (room.phase !== 'choose_seat' || idx !== room.sitterIndex) return fail(ws, '今は着席できません');
        const seat = Number(msg.seat);
        if (!room.remainingSeats.includes(seat)) return fail(ws, 'そのイスは選べません');
        const shocked = seat === room.trapSeat;
        const sitter = room.players[idx];
        const before = sitter.score;

        if (shocked) {
          sitter.score = 0;
          sitter.shocks += 1;
        } else {
          sitter.score += seat;
          room.remainingSeats = room.remainingSeats.filter(n => n !== seat);
        }

        room.lastResult = {
          seat,
          trapSeat: room.trapSeat,
          shocked,
          playerIndex: idx,
          pointsBefore: before,
          pointsAfter: sitter.score,
          gained: shocked ? 0 : seat
        };
        room.trapSeat = null;
        room.phase = 'result';
        broadcastState(room);

        if (checkEnd(room, idx)) return;
        setTimeout(() => {
          if (rooms.get(room.code) === room && room.phase === 'result') nextTurn(room);
        }, 3600);
        return;
      }

      if (msg.type === 'rematch_vote') {
        if (room.phase !== 'game_over') return fail(ws, 'ゲーム終了後に使えます');
        room.rematchVotes[idx] = true;
        if (room.rematchVotes[0] && room.rematchVotes[1]) startGame(room);
        else broadcastState(room);
        return;
      }

      if (msg.type === 'leave') {
        const opponentIndex = 1 - idx;
        if (room.phase !== 'waiting' && room.phase !== 'game_over' && room.players[opponentIndex]) {
          endGame(room, opponentIndex, 'opponent_left');
        }
        found.player.connected = false;
        found.player.ws = null;
        ws.session = null;
        send(ws, { type: 'left' });
      }
    } catch (err) {
      console.error(err);
      fail(ws, 'サーバー内部でエラーが発生しました');
    }
  });

  ws.on('close', () => {
    const s = ws.session;
    if (!s) return;
    const room = rooms.get(s.roomCode);
    if (!room) return;
    const found = findByToken(room, s.playerToken);
    if (!found || found.player.ws !== ws) return;
    found.player.ws = null;
    found.player.connected = false;
    found.player.disconnectedAt = Date.now();
    broadcastState(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!['waiting', 'game_over'].includes(room.phase)) {
      room.players.forEach((p, idx) => {
        if (p && !p.connected && p.disconnectedAt && now - p.disconnectedAt > RECONNECT_GRACE_MS && room.phase !== 'game_over') {
          const opponent = room.players[1 - idx];
          if (opponent) endGame(room, 1 - idx, 'disconnect_timeout');
        }
      });
    }
    if (now - room.updatedAt > ROOM_TTL_MS) rooms.delete(code);
  }
}, 5000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Electric Chair Duel listening on http://localhost:${PORT}`);
});
