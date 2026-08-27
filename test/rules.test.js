import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { get, ref, set } from 'firebase/database';
import { createCommit, generateNonce } from '../public/js/game/commitment.js';
import { replayOnlineGame } from '../public/js/game/replay.js';

const projectId = 'electric-chair-duel-test';
const roomId = 'abcdefghijklmnopqrstuv';
const now = () => Date.now();
let env;

before(async () => {
  env = await initializeTestEnvironment({ projectId, database: { rules: await readFile(new URL('../database.rules.json', import.meta.url), 'utf8') } });
});
after(async () => env?.cleanup());

async function seedRoom() {
  const hostDb = env.authenticatedContext('host_uid').database();
  await assertSucceeds(set(ref(hostDb, 'userRooms/host_uid/slot1'), roomId));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}`), {
    meta: { schemaVersion: 2, protocolVersion: 'ecd-v2', roomId, createdAt: now(), host: { uid: 'host_uid', name: 'HOST' } }
  }));
  return hostDb;
}

async function joinAndStart() {
  const hostDb = await seedRoom();
  const guestDb = env.authenticatedContext('guest_uid').database();
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/meta/guest`), { uid: 'guest_uid', name: 'GUEST', protocolVersion: 'ecd-v2', joinedAt: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/matches/m000001/meta`), { schemaVersion: 2, gameNumber: 1, matchId: 'ABCDEFGHIJKLMNOPQRSTUV', createdAt: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/currentKey`), 'm000001'));
  return { hostDb, guestDb };
}

const turnPath = suffix => `rooms/${roomId}/game/matches/m000001/turns/${suffix}`;

test('room creation requires a capped owner reservation and exact v2 metadata', async () => {
  await env.clearDatabase();
  const hostDb = env.authenticatedContext('host_uid').database();
  await assertFails(set(ref(hostDb, `rooms/${roomId}`), { meta: { schemaVersion: 2, protocolVersion: 'ecd-v2', roomId, createdAt: now(), host: { uid: 'host_uid', name: 'HOST' } } }));
  for (let index = 1; index <= 3; index += 1) await assertSucceeds(set(ref(hostDb, `userRooms/host_uid/slot${index}`), String(index).padStart(22, 'a')));
  await assertFails(set(ref(hostDb, 'userRooms/host_uid/slot4'), 'z'.repeat(22)));
});

test('room creation cannot pre-seed a guest or game', async () => {
  await env.clearDatabase();
  const hostDb = env.authenticatedContext('host_uid').database();
  await assertSucceeds(set(ref(hostDb, 'userRooms/host_uid/slot1'), roomId));
  await assertFails(set(ref(hostDb, `rooms/${roomId}`), {
    meta: { schemaVersion: 2, protocolVersion: 'ecd-v2', roomId, createdAt: now(), host: { uid: 'host_uid', name: 'HOST' }, guest: { uid: 'victim_uid', name: 'VICTIM', protocolVersion: 'ecd-v2', joinedAt: now() } },
    game: { currentKey: 'm000001' }
  }));
});

test('only one v2 guest can claim the capability URL', async () => {
  await env.clearDatabase(); await seedRoom();
  const guestDb = env.authenticatedContext('guest_uid').database();
  const attackerDb = env.authenticatedContext('attacker_uid').database();
  await assertFails(set(ref(guestDb, `rooms/${roomId}/meta/guest`), { uid: 'guest_uid', name: 'GUEST', protocolVersion: 'ecd-v1', joinedAt: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/meta/guest`), { uid: 'guest_uid', name: 'GUEST', protocolVersion: 'ecd-v2', joinedAt: now() }));
  await assertFails(set(ref(attackerDb, `rooms/${roomId}/meta/guest`), { uid: 'attacker_uid', name: 'ATTACKER', protocolVersion: 'ecd-v2', joinedAt: now() }));
  await assertFails(get(ref(attackerDb, `rooms/${roomId}`)));
});

test('presence uses per-tab connections owned by each participant', async () => {
  await env.clearDatabase(); const { hostDb, guestDb } = await joinAndStart();
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/presence/host_uid/connections/tab_one`), { at: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/presence/host_uid/connections/tab_two`), { at: now() }));
  await assertFails(set(ref(guestDb, `rooms/${roomId}/presence/host_uid/connections/attack`), { at: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/presence/host_uid/connections/tab_one`), null));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/presence/host_uid/lastChanged`), now()));
});

test('events are role-bound, ordered and write-once', async () => {
  await env.clearDatabase(); const { hostDb, guestDb } = await joinAndStart();
  const commit = { uid: 'host_uid', hash: 'a'.repeat(64), at: now() };
  await assertFails(set(ref(guestDb, turnPath('h000001/commit')), { ...commit, uid: 'guest_uid' }));
  await assertSucceeds(set(ref(hostDb, turnPath('h000001/commit')), commit));
  await assertFails(set(ref(hostDb, turnPath('h000001/choice')), { uid: 'host_uid', seat: 8, at: now() }));
  await assertSucceeds(set(ref(guestDb, turnPath('h000001/choice')), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertFails(set(ref(guestDb, turnPath('h000001/choice')), { uid: 'guest_uid', seat: 9, at: now() }));
  await assertFails(set(ref(hostDb, turnPath('h000001/commit')), null));
});

test('future turns are rejected until the predecessor is resolved', async () => {
  await env.clearDatabase(); const { hostDb, guestDb } = await joinAndStart();
  await assertFails(set(ref(guestDb, turnPath('g000002/commit')), { uid: 'guest_uid', hash: 'b'.repeat(64), at: now() }));
  await assertSucceeds(set(ref(hostDb, turnPath('h000001/commit')), { uid: 'host_uid', hash: 'a'.repeat(64), at: now() }));
  await assertSucceeds(set(ref(guestDb, turnPath('h000001/choice')), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertSucceeds(set(ref(hostDb, turnPath('h000001/reveal')), { uid: 'host_uid', seat: 12, nonce: 'c'.repeat(32), at: now() }));
  await assertSucceeds(set(ref(guestDb, turnPath('g000002/commit')), { uid: 'guest_uid', hash: 'b'.repeat(64), at: now() }));
});

test('reveal timeout is exclusive and server-timed', async () => {
  await env.clearDatabase(); const { hostDb, guestDb } = await joinAndStart();
  await assertSucceeds(set(ref(hostDb, turnPath('h000001/commit')), { uid: 'host_uid', hash: 'c'.repeat(64), at: now() }));
  await assertSucceeds(set(ref(guestDb, turnPath('h000001/choice')), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertFails(set(ref(guestDb, turnPath('h000001/forfeit')), { uid: 'guest_uid', reason: 'reveal_timeout', at: now() }));
  await assertFails(set(ref(guestDb, turnPath('h000001/reveal')), { uid: 'guest_uid', seat: 12, nonce: 'd'.repeat(32), at: now() }));
  await assertSucceeds(set(ref(hostDb, turnPath('h000001/reveal')), { uid: 'host_uid', seat: 12, nonce: 'd'.repeat(32), at: now() }));
  await assertFails(set(ref(hostDb, turnPath('h000001/reveal')), null));
});

test('disconnect forfeit requires no active tab and 120 seconds offline', async () => {
  await env.clearDatabase(); const { hostDb } = await joinAndStart();
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/disconnectForfeits/m000001/host_uid`), { uid: 'host_uid', opponentUid: 'guest_uid', reason: 'disconnect_timeout', at: now() }));
  await env.withSecurityRulesDisabled(async context => set(ref(context.database(), `rooms/${roomId}/presence/guest_uid`), { connections: {}, lastChanged: now() - 121000 }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/disconnectForfeits/m000001/host_uid`), { uid: 'host_uid', opponentUid: 'guest_uid', reason: 'disconnect_timeout', at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/disconnectForfeits/m000001/host_uid`), null));
});

test('both participants can vote and host can start a same-room rematch', async () => {
  await env.clearDatabase(); const { hostDb, guestDb } = await joinAndStart();
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/rematchVotes/m000002/host_uid`), { uid: 'host_uid', at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/matches/m000002/meta`), { schemaVersion: 2, gameNumber: 2, matchId: 'BCDEFGHIJKLMNOPQRSTUVW', createdAt: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/game/rematchVotes/m000002/guest_uid`), { uid: 'guest_uid', at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/matches/m000002/meta`), { schemaVersion: 2, gameNumber: 9, matchId: 'BCDEFGHIJKLMNOPQRSTUVW', createdAt: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/matches/m000002/meta`), { schemaVersion: 2, gameNumber: 2, matchId: 'BCDEFGHIJKLMNOPQRSTUVW', createdAt: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/currentKey`), 'm000002'));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/currentKey`), 'm000001'));
});

test('explicit leave is immutable and participant-bound', async () => {
  await env.clearDatabase(); const { hostDb, guestDb } = await joinAndStart();
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/game/leaves/m000001/guest_uid`), { uid: 'guest_uid', at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/leaves/m000001/guest_uid`), null));
});

test('host can release before the first move and then remove its reservation', async () => {
  await env.clearDatabase(); const { hostDb } = await joinAndStart();
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}`), null));
  await assertSucceeds(set(ref(hostDb, 'userRooms/host_uid/slot1'), null));
});

test('expired rooms reject events and can be removed by either participant', async () => {
  await env.clearDatabase();
  await env.withSecurityRulesDisabled(async context => set(ref(context.database(), `rooms/${roomId}`), {
    meta: { schemaVersion: 2, protocolVersion: 'ecd-v2', roomId, createdAt: now() - 86400001, host: { uid: 'host_uid', name: 'HOST' }, guest: { uid: 'guest_uid', name: 'GUEST', protocolVersion: 'ecd-v2', joinedAt: now() - 86400000 } },
    game: { currentKey: 'm000001', matches: { m000001: { meta: { schemaVersion: 2, gameNumber: 1, matchId: 'ABCDEFGHIJKLMNOPQRSTUV', createdAt: now() - 86400000 }, turns: { h000001: { commit: { uid: 'host_uid', hash: 'a'.repeat(64), at: now() - 86400000 } } } } } }
  }));
  const guestDb = env.authenticatedContext('guest_uid').database();
  await assertFails(set(ref(guestDb, turnPath('h000001/choice')), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}`), null));
  assert.ok(true);
});

test('two clients complete a verified turn and enter a same-room rematch', async () => {
  await env.clearDatabase(); const { hostDb, guestDb } = await joinAndStart();
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/presence/host_uid/connections/host_tab`), { at: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/presence/guest_uid/connections/guest_tab`), { at: now() }));
  const nonce = generateNonce();
  const hash = await createCommit({ roomId, matchId: 'ABCDEFGHIJKLMNOPQRSTUV', turnNumber: 1, trapperUid: 'host_uid', seat: 12, nonce });
  await assertSucceeds(set(ref(hostDb, turnPath('h000001/commit')), { uid: 'host_uid', hash, at: now() }));
  await assertSucceeds(set(ref(guestDb, turnPath('h000001/choice')), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertSucceeds(set(ref(hostDb, turnPath('h000001/reveal')), { uid: 'host_uid', seat: 12, nonce, at: now() - 6000 }));
  const room = (await get(ref(hostDb, `rooms/${roomId}`))).val();
  const hostState = await replayOnlineGame({ roomId, room, uid: 'host_uid', now: now() });
  const guestState = await replayOnlineGame({ roomId, room, uid: 'guest_uid', now: now() });
  assert.equal(hostState.turnNumber, 2); assert.equal(guestState.turnNumber, 2);
  assert.equal(hostState.players[1].score, 8); assert.equal(guestState.players[1].score, 8);
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/rematchVotes/m000002/host_uid`), { uid: 'host_uid', at: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/game/rematchVotes/m000002/guest_uid`), { uid: 'guest_uid', at: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/matches/m000002/meta`), { schemaVersion: 2, gameNumber: 2, matchId: 'BCDEFGHIJKLMNOPQRSTUVW', createdAt: now() }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/currentKey`), 'm000002'));
  const rematchRoom = (await get(ref(hostDb, `rooms/${roomId}`))).val();
  const rematchState = await replayOnlineGame({ roomId, room: rematchRoom, uid: 'host_uid', now: now() });
  assert.equal(rematchState.gameNumber, 2); assert.equal(rematchState.phase, 'set_trap');
});
