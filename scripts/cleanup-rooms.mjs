import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('firebase-tools/lib/apiv2');
const { getGlobalDefaultAccount } = require('firebase-tools/lib/auth');
const { getDefaultDatabaseInstance } = require('firebase-tools/lib/getDefaultDatabaseInstance');
const { getDatabaseInstanceDetails } = require('firebase-tools/lib/management/database');
const { requireAuth } = require('firebase-tools/lib/requireAuth');

const DAY_MS = 86400000;
const projectId = process.argv[2];
const execute = process.argv.includes('--execute');

if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '')) {
  throw new Error('Usage: node scripts/cleanup-rooms.mjs <firebase-project-id> [--execute]');
}

const account = getGlobalDefaultAccount();
if (!account) throw new Error('Firebase CLIでログインしてください');
await requireAuth({ project: projectId, user: account.user, tokens: account.tokens });

const instanceName = await getDefaultDatabaseInstance(projectId);
if (!instanceName) throw new Error('Realtime Databaseの既定インスタンスが見つかりません');
const instance = await getDatabaseInstanceDetails(projectId, instanceName);
const client = new Client({ urlPrefix: instance.databaseUrl, auth: true });
const cutoff = Date.now() - DAY_MS;
let response;
let queryMode = 'indexed';
try {
  response = await client.get('/rooms.json', {
    queryParams: { orderBy: '"meta/createdAt"', endAt: cutoff }
  });
} catch (error) {
  if (!String(error?.message || '').includes('Index not defined')) throw error;
  queryMode = 'full-scan-fallback';
  response = await client.get('/rooms.json');
}
const rooms = response.body && typeof response.body === 'object' ? response.body : {};
const expiredEntries = Object.entries(rooms)
  .filter(([, room]) => Number.isFinite(room?.meta?.createdAt) && room.meta.createdAt <= cutoff)
  .map(([roomId, room]) => ({ roomId, hostUid: room?.meta?.host?.uid }));

if (execute && expiredEntries.length) {
  const userRoomsResponse = await client.get('/userRooms.json');
  const userRooms = userRoomsResponse.body && typeof userRoomsResponse.body === 'object' ? userRoomsResponse.body : {};
  const deletions = {};
  expiredEntries.forEach(({ roomId, hostUid }) => {
    deletions[`rooms/${roomId}`] = null;
    if (/^[A-Za-z0-9_-]{1,128}$/.test(String(hostUid || ''))) {
      Object.entries(userRooms[hostUid] || {}).forEach(([slot, reservedRoomId]) => {
        if (reservedRoomId === roomId) deletions[`userRooms/${hostUid}/${slot}`] = null;
      });
    }
  });
  await client.patch('/.json', deletions, {
    queryParams: { print: 'silent', writeSizeLimit: 'small' }
  });
}

console.log(JSON.stringify({
  ok: true,
  projectId,
  instance: instanceName,
  mode: execute ? 'execute' : 'dry-run',
  inspected: Object.keys(rooms).length,
  expired: expiredEntries.length,
  deleted: execute ? expiredEntries.length : 0,
  retentionHours: 24,
  queryMode
}));
