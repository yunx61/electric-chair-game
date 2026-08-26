import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { get, ref, set } from 'firebase/database';

const projectId = 'electric-chair-duel-test';
const roomId = 'abcdefghijklmnopqrstuv';
const now = () => Date.now();
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    database: { rules: await readFile(new URL('../database.rules.json', import.meta.url), 'utf8') }
  });
});

after(async () => env?.cleanup());

async function seedRoom() {
  const hostDb = env.authenticatedContext('host_uid').database();
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}`), {
    meta: {
      schemaVersion: 1,
      roomId,
      createdAt: now(),
      host: { uid: 'host_uid', name: 'HOST' }
    }
  }));
  return hostDb;
}

test('room creation cannot pre-seed a guest or game through the parent grant', async () => {
  await env.clearDatabase();
  const hostDb = env.authenticatedContext('host_uid').database();
  await assertFails(set(ref(hostDb, `rooms/${roomId}`), {
    meta: {
      schemaVersion: 1,
      roomId,
      createdAt: now(),
      host: { uid: 'host_uid', name: 'HOST' },
      guest: { uid: 'victim_uid', name: 'VICTIM', joinedAt: now() }
    },
    game: { meta: { schemaVersion: 1, matchId: 'ABCDEFGHIJKLMNOPQRSTUV', createdAt: now() } }
  }));
});

async function joinAndStart() {
  const hostDb = await seedRoom();
  const guestDb = env.authenticatedContext('guest_uid').database();
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/meta/guest`), {
    uid: 'guest_uid', name: 'GUEST', joinedAt: now()
  }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/meta`), {
    schemaVersion: 1, matchId: 'ABCDEFGHIJKLMNOPQRSTUV', createdAt: now()
  }));
  return { hostDb, guestDb };
}

test('only a capability holder can claim the single guest slot', async () => {
  await env.clearDatabase();
  await seedRoom();
  const guestDb = env.authenticatedContext('guest_uid').database();
  const attackerDb = env.authenticatedContext('attacker_uid').database();
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/meta/guest`), { uid: 'guest_uid', name: 'GUEST', joinedAt: now() }));
  await assertFails(set(ref(attackerDb, `rooms/${roomId}/meta/guest`), { uid: 'attacker_uid', name: 'ATTACKER', joinedAt: now() }));
  await assertFails(get(ref(attackerDb, `rooms/${roomId}`)));
});

test('events are role-bound, ordered and write-once', async () => {
  await env.clearDatabase();
  const { hostDb, guestDb } = await joinAndStart();
  const commit = { uid: 'host_uid', hash: 'a'.repeat(64), at: now() };
  await assertFails(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/commit`), { ...commit, uid: 'guest_uid' }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/commit`), commit));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/choice`), { uid: 'host_uid', seat: 8, at: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/choice`), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertFails(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/choice`), { uid: 'guest_uid', seat: 9, at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/commit`), null));
});

test('parent overwrite and early timeout claims are rejected', async () => {
  await env.clearDatabase();
  const { hostDb, guestDb } = await joinAndStart();
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game`), { hacked: true }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/commit`), { uid: 'host_uid', hash: 'b'.repeat(64), at: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/choice`), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertFails(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/forfeit`), { uid: 'guest_uid', reason: 'reveal_timeout', at: now() }));
  assert.ok(true);
});

test('reveal is setter-only, bounded and immutable', async () => {
  await env.clearDatabase();
  const { hostDb, guestDb } = await joinAndStart();
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/commit`), { uid: 'host_uid', hash: 'c'.repeat(64), at: now() }));
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/choice`), { uid: 'guest_uid', seat: 8, at: now() }));
  await assertFails(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/reveal`), { uid: 'guest_uid', seat: 12, nonce: 'd'.repeat(32), at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/reveal`), { uid: 'host_uid', seat: 13, nonce: 'd'.repeat(32), at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/reveal`), { uid: 'host_uid', seat: 12, nonce: 'd'.repeat(32), at: now(), extra: true }));
  await assertSucceeds(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/reveal`), { uid: 'host_uid', seat: 12, nonce: 'd'.repeat(32), at: now() }));
  await assertFails(set(ref(hostDb, `rooms/${roomId}/game/turns/h000001/reveal`), null));
});

test('the sitter may claim a reveal timeout only after server time passes', async () => {
  await env.clearDatabase();
  const { guestDb } = await joinAndStart();
  await env.withSecurityRulesDisabled(async context => {
    await set(ref(context.database(), `rooms/${roomId}/game/turns/h000001`), {
      commit: { uid: 'host_uid', hash: 'e'.repeat(64), at: now() - 92000 },
      choice: { uid: 'guest_uid', seat: 8, at: now() - 91000 }
    });
  });
  await assertSucceeds(set(ref(guestDb, `rooms/${roomId}/game/turns/h000001/forfeit`), {
    uid: 'guest_uid', reason: 'reveal_timeout', at: now()
  }));
});
