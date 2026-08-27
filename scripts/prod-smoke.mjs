import { deleteApp, initializeApp } from 'firebase/app';
import { getAuth, getIdToken, signInAnonymously } from 'firebase/auth';
import { get, getDatabase, ref, runTransaction, serverTimestamp, set } from 'firebase/database';

const projectId = process.argv[2];
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '')) {
  throw new Error('Usage: node scripts/prod-smoke.mjs <firebase-project-id>');
}

const configResponse = await fetch(`https://${projectId}.web.app/__/firebase/init.json`, {
  headers: { accept: 'application/json' }
});
if (!configResponse.ok) throw new Error(`Firebase config returned ${configResponse.status}`);
const config = await configResponse.json();
if (config.projectId !== projectId || !config.databaseURL || !config.apiKey) {
  throw new Error('Firebase Hosting returned an incomplete configuration');
}

const randomId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
const roomId = randomId();
const clients = ['host', 'guest', 'outsider'].map(role => {
  const app = initializeApp(config, `prod-smoke-${role}-${randomId()}`);
  return { app, auth: getAuth(app), db: getDatabase(app) };
});
let roomCreated = false;

try {
  await Promise.all(clients.map(client => signInAnonymously(client.auth)));
  const [host, guest, outsider] = clients;
  const hostUid = host.auth.currentUser.uid;
  const guestUid = guest.auth.currentUser.uid;
  if (new Set(clients.map(client => client.auth.currentUser.uid)).size !== clients.length) {
    throw new Error('Smoke clients did not receive isolated anonymous identities');
  }

  await set(ref(host.db, `rooms/${roomId}`), {
    meta: {
      schemaVersion: 1,
      roomId,
      createdAt: serverTimestamp(),
      host: { uid: hostUid, name: 'SmokeHost' }
    }
  });
  roomCreated = true;

  const claim = await runTransaction(ref(guest.db, `rooms/${roomId}/meta/guest`), current => {
    if (current == null) return { uid: guestUid, name: 'SmokeGuest', joinedAt: serverTimestamp() };
    return;
  }, { applyLocally: false });
  if (!claim.committed) throw new Error('Guest claim was rejected');

  const matchId = randomId();
  await set(ref(host.db, `rooms/${roomId}/game/meta`), {
    schemaVersion: 1,
    matchId,
    createdAt: serverTimestamp()
  });

  const [hostView, guestView] = await Promise.all([
    get(ref(host.db, `rooms/${roomId}/game/meta`)),
    get(ref(guest.db, `rooms/${roomId}/game/meta`))
  ]);
  if (hostView.val()?.matchId !== matchId || guestView.val()?.matchId !== matchId) {
    throw new Error('Participants did not receive the same match');
  }

  const outsiderToken = await getIdToken(outsider.auth.currentUser);
  const outsiderResponse = await fetch(`${config.databaseURL}/rooms/${roomId}.json?auth=${encodeURIComponent(outsiderToken)}`);
  const outsiderDenied = outsiderResponse.status === 401 || outsiderResponse.status === 403;
  if (!outsiderDenied) throw new Error('Outsider room read was not denied');

  await set(ref(host.db, `rooms/${roomId}`), null);
  roomCreated = false;
  console.log(JSON.stringify({ ok: true, anonymousAuth: true, guestClaim: true, outsiderDenied: true, hostCleanup: true }));
} finally {
  if (roomCreated) await set(ref(clients[0].db, `rooms/${roomId}`), null).catch(() => {});
  await Promise.allSettled(clients.map(client => deleteApp(client.app)));
}

process.exit(0);
