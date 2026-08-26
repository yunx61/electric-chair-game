const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const WebSocket = require('ws');
const { createGameServer, cleanName } = require('../server');

async function startTestServer(t, options = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'electric-chair-test-'));
  const snapshotFile = path.join(tempDir, 'rooms.json');
  const app = createGameServer({
    port: 0,
    snapshotFile,
    allowMissingOrigin: false,
    isProduction: true,
    maxRooms: 20,
    ...options
  });
  const address = await app.start();
  t.after(async () => {
    await app.stop();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  return { app, port: address.port, snapshotFile };
}

function request(port, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

function rawRequest(port, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.end(payload));
    socket.on('data', chunk => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
}

function connectWebSocket(port, origin = `http://127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
    const onError = error => reject(error);
    ws.once('error', onError);
    ws.once('open', () => {
      ws.off('error', onError);
      resolve(ws);
    });
  });
}

function waitForMessage(ws, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for WebSocket message'));
    }, timeoutMs);
    const onMessage = raw => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

function waitForClose(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket close')), timeoutMs);
    ws.once('close', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

test('HTTP responses include security headers and useful cache policies', async t => {
  const { port } = await startTestServer(t, { trustProxy: true });
  const home = await request(port, '/', { headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(home.statusCode, 200);
  assert.match(home.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.equal(home.headers['x-frame-options'], 'DENY');
  assert.match(home.headers['strict-transport-security'], /max-age=31536000/);
  assert.equal(home.headers['cache-control'], 'no-store');

  const asset = await request(port, '/styles.css');
  assert.equal(asset.statusCode, 200);
  assert.match(asset.headers['cache-control'], /max-age=3600/);

  const serviceWorker = await request(port, '/service-worker.js');
  assert.equal(serviceWorker.statusCode, 200);
  assert.equal(serviceWorker.headers['cache-control'], 'no-cache');

  const health = await request(port, '/health');
  assert.deepEqual(JSON.parse(health.body), { ok: true });
});

test('malformed URI returns 400 and the server remains healthy', async t => {
  const { port } = await startTestServer(t);
  const malformed = await rawRequest(port, `GET /%E0%A4%A HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  assert.match(malformed, /^HTTP\/1\.1 400/);
  const health = await request(port, '/health');
  assert.equal(health.statusCode, 200);
});

test('foreign WebSocket origins are rejected while same-origin connects', async t => {
  const { port } = await startTestServer(t);
  await assert.rejects(connectWebSocket(port, 'https://evil.example'));
  const ws = await connectWebSocket(port);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.close();
});

test('AI game keeps trap position private until result and persists only token hashes', async t => {
  const { app, port, snapshotFile } = await startTestServer(t);
  const ws = await connectWebSocket(port);
  const sessionPromise = waitForMessage(ws, message => message.type === 'session');
  const activeStatePromise = waitForMessage(ws, message => message.type === 'state' && ['set_trap', 'choose_seat'].includes(message.state?.phase));
  ws.send(JSON.stringify({ type: 'create_ai_room', name: 'REVIEW', aiId: 'rei', difficulty: 'normal' }));
  const [session, activeState] = await Promise.all([sessionPromise, activeStatePromise]);
  assert.match(session.playerToken, /^[a-f0-9]{48}$/);
  assert.equal(Object.hasOwn(activeState.state, 'trapSeat'), false);
  assert.equal(activeState.state.lastResult, null);

  const duplicatePromise = waitForMessage(ws, message => message.type === 'error' && message.code === 'ALREADY_IN_ROOM');
  ws.send(JSON.stringify({ type: 'create_room', name: 'SECOND' }));
  await duplicatePromise;

  await app.flushRooms();
  const snapshot = await fs.readFile(snapshotFile, 'utf8');
  assert.equal(snapshot.includes(session.playerToken), false);
  assert.equal(snapshot.includes('tokenHash'), true);
  assert.equal(snapshot.includes('ownerIp'), false);
  ws.close();
});

test('two human clients can play a turn and reconnect with the issued token', async t => {
  const { port } = await startTestServer(t);
  const host = await connectWebSocket(port);
  const hostSessionPromise = waitForMessage(host, message => message.type === 'session');
  const waitingPromise = waitForMessage(host, message => message.type === 'state' && message.state?.phase === 'waiting');
  host.send(JSON.stringify({ type: 'create_room', name: 'HOST' }));
  const [hostSession] = await Promise.all([hostSessionPromise, waitingPromise]);

  const guest = await connectWebSocket(port);
  const guestSessionPromise = waitForMessage(guest, message => message.type === 'session');
  const hostActivePromise = waitForMessage(host, message => message.type === 'state' && message.state?.phase === 'set_trap');
  const guestActivePromise = waitForMessage(guest, message => message.type === 'state' && message.state?.phase === 'set_trap');
  guest.send(JSON.stringify({ type: 'join_room', name: 'GUEST', code: hostSession.roomCode }));
  const [guestSession, hostActive, guestActive] = await Promise.all([guestSessionPromise, hostActivePromise, guestActivePromise]);

  const setter = hostActive.state.setterIndex === 0 ? host : guest;
  const sitter = hostActive.state.sitterIndex === 0 ? host : guest;
  const chooseHostPromise = waitForMessage(host, message => message.type === 'state' && message.state?.phase === 'choose_seat');
  const chooseGuestPromise = waitForMessage(guest, message => message.type === 'state' && message.state?.phase === 'choose_seat');
  setter.send(JSON.stringify({ type: 'set_trap', seat: 1 }));
  await Promise.all([chooseHostPromise, chooseGuestPromise]);

  const resultHostPromise = waitForMessage(host, message => message.type === 'state' && message.state?.phase === 'result');
  const resultGuestPromise = waitForMessage(guest, message => message.type === 'state' && message.state?.phase === 'result');
  sitter.send(JSON.stringify({ type: 'choose_seat', seat: 2 }));
  const [hostResult, guestResult] = await Promise.all([resultHostPromise, resultGuestPromise]);
  assert.equal(hostResult.state.lastResult.trapSeat, 1);
  assert.equal(guestResult.state.lastResult.trapSeat, 1);
  assert.equal(hostResult.state.lastResult.shocked, false);

  const guestIndex = guestActive.state.you;
  const disconnectedPromise = waitForMessage(host, message => message.type === 'state' && message.state?.players?.[guestIndex]?.connected === false);
  guest.terminate();
  await disconnectedPromise;

  const resumed = await connectWebSocket(port);
  const resumedSessionPromise = waitForMessage(resumed, message => message.type === 'session');
  const resumedStatePromise = waitForMessage(resumed, message => message.type === 'state' && message.state?.players?.[guestIndex]?.connected === true);
  resumed.send(JSON.stringify({ type: 'resume', code: guestSession.roomCode, token: guestSession.playerToken }));
  const [resumedSession] = await Promise.all([resumedSessionPromise, resumedStatePromise]);
  assert.equal(resumedSession.playerIndex, guestIndex);
  host.close();
  resumed.close();
});

test('oversized WebSocket payload is rejected without stopping HTTP service', async t => {
  const { port } = await startTestServer(t);
  const ws = await connectWebSocket(port);
  const closePromise = waitForClose(ws);
  ws.send('x'.repeat(20 * 1024));
  const closeCode = await closePromise;
  assert.equal(closeCode, 1009);
  const health = await request(port, '/health');
  assert.equal(health.statusCode, 200);
});

test('names remove control and bidi override characters and remain bounded', () => {
  assert.equal(cleanName('  <A>\u202e\nB  '), 'AB');
  assert.equal([...cleanName('あ'.repeat(30))].length, 16);
});
