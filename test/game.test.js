import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommit, generateNonce, verifyCommit } from '../public/js/game/commitment.js';
import { replayOnlineGame } from '../public/js/game/replay.js';
import { loadPendingSecret, removePendingSecret, savePendingSecret } from '../public/js/storage/local-secrets.js';

const roomId = 'abcdefghijklmnopqrstuv';
const matchId = 'ABCDEFGHIJKLMNOPQRSTUV';
const hostUid = 'host_uid';
const guestUid = 'guest_uid';

function roomWith(turns = {}) {
  return {
    meta: {
      host: { uid: hostUid, name: 'HOST' },
      guest: { uid: guestUid, name: 'GUEST' }
    },
    presence: {
      [hostUid]: { state: 'online' },
      [guestUid]: { state: 'online' }
    },
    game: { meta: { matchId }, turns }
  };
}

async function resolvedTurn({ turnNumber = 1, setterUid = hostUid, sitterUid = guestUid, trapSeat = 12, choiceSeat = 8, at = 1000 } = {}) {
  const nonce = generateNonce();
  const hash = await createCommit({ roomId, matchId, turnNumber, trapperUid: setterUid, seat: trapSeat, nonce });
  return {
    commit: { uid: setterUid, hash, at },
    choice: { uid: sitterUid, seat: choiceSeat, at: at + 10 },
    reveal: { uid: setterUid, seat: trapSeat, nonce, at: at + 20 }
  };
}

test('commitment binds room, match, turn, uid, seat and nonce', async () => {
  const nonce = generateNonce();
  assert.match(nonce, /^[a-f0-9]{32}$/);
  const input = { roomId, matchId, turnNumber: 1, trapperUid: hostUid, seat: 12, nonce };
  const hash = await createCommit(input);
  assert.equal(await verifyCommit(hash, input), true);
  for (const patch of [
    { roomId: 'zzzzzzzzzzzzzzzzzzzzzz' },
    { matchId: 'ZZZZZZZZZZZZZZZZZZZZZZ' },
    { turnNumber: 2 },
    { trapperUid: guestUid },
    { seat: 11 },
    { nonce: '0'.repeat(32) }
  ]) assert.equal(await verifyCommit(hash, { ...input, ...patch }), false);
});

test('replay derives score, used seats and the next deterministic role', async () => {
  const turn = await resolvedTurn();
  const state = await replayOnlineGame({ roomId, room: roomWith({ h000001: turn }), uid: hostUid, now: 7000 });
  assert.equal(state.phase, 'set_trap');
  assert.equal(state.turnNumber, 2);
  assert.equal(state.setterIndex, 1);
  assert.equal(state.players[1].score, 8);
  assert.equal(state.remainingSeats.includes(8), false);
});

test('replay detects a changed reveal and voids the match', async () => {
  const turn = await resolvedTurn();
  turn.reveal.seat = 11;
  const state = await replayOnlineGame({ roomId, room: roomWith({ h000001: turn }), uid: guestUid, now: 7000 });
  assert.equal(state.phase, 'game_over');
  assert.equal(state.endReason, 'protocol_violation');
  assert.equal(state.winnerIndex, null);
  assert.equal(state.protocolError, 'COMMIT_REVEAL_MISMATCH');
});

test('future and incorrectly prefixed events never advance replay', async () => {
  const future = await resolvedTurn({ turnNumber: 2, setterUid: guestUid, sitterUid: hostUid });
  const state = await replayOnlineGame({ roomId, room: roomWith({ g000002: future }), uid: hostUid, now: 7000 });
  assert.equal(state.phase, 'set_trap');
  assert.equal(state.turnNumber, 1);
  assert.equal(state.players[0].score, 0);
  assert.equal(state.players[1].score, 0);
});

test('server-timed forfeit resolves only after the reveal window event exists', async () => {
  const nonce = generateNonce();
  const hash = await createCommit({ roomId, matchId, turnNumber: 1, trapperUid: hostUid, seat: 12, nonce });
  const turn = {
    commit: { uid: hostUid, hash, at: 1000 },
    choice: { uid: guestUid, seat: 8, at: 1100 },
    forfeit: { uid: guestUid, reason: 'reveal_timeout', at: 91100 }
  };
  const state = await replayOnlineGame({ roomId, room: roomWith({ h000001: turn }), uid: hostUid, now: 92000 });
  assert.equal(state.phase, 'game_over');
  assert.equal(state.winnerIndex, 1);
  assert.equal(state.endReason, 'reveal_timeout');
});

test('pending reveal data survives a browser session restart and rejects corrupt data', () => {
  const createStorage = () => {
    const values = new Map();
    return {
      getItem: key => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: key => values.delete(key),
      clear: () => values.clear()
    };
  };
  const previousLocal = globalThis.localStorage;
  const previousSession = globalThis.sessionStorage;
  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();
  try {
    const secret = { roomId, matchId, turnNumber: 1, seat: 12, nonce: 'a'.repeat(32), commitHash: 'b'.repeat(64) };
    savePendingSecret(secret);
    globalThis.sessionStorage.clear();
    const restored = loadPendingSecret(roomId, matchId, 1);
    assert.deepEqual({ ...restored, expiresAt: undefined }, { ...secret, expiresAt: undefined });
    assert.ok(restored.expiresAt > Date.now());
    removePendingSecret(roomId, matchId, 1);
    assert.equal(loadPendingSecret(roomId, matchId, 1), null);

    const key = `ecd_pending_secret:${roomId}:${matchId}:1`;
    globalThis.localStorage.setItem(key, JSON.stringify({ ...secret, seat: 99, expiresAt: Date.now() + 10000 }));
    assert.equal(loadPendingSecret(roomId, matchId, 1), null);
  } finally {
    if (previousLocal === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocal;
    if (previousSession === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previousSession;
  }
});
