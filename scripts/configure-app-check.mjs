import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('firebase-tools/lib/apiv2');
const { getGlobalDefaultAccount } = require('firebase-tools/lib/auth');
const { requireAuth } = require('firebase-tools/lib/requireAuth');
const { check, ensure } = require('firebase-tools/lib/ensureApiEnabled');
const { generateServiceIdentityAndPoll } = require('firebase-tools/lib/gcp/serviceusage');

const projectId = process.argv[2];
const projectNumber = process.argv[3];
const appId = process.argv[4];
const execute = process.argv.includes('--execute');
if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '') || !/^\d{6,20}$/.test(projectNumber || '') || !/^1:\d+:web:[a-f0-9]+$/.test(appId || '')) {
  throw new Error('Usage: node scripts/configure-app-check.mjs <project-id> <project-number> <web-app-id> [--execute]');
}
const account = getGlobalDefaultAccount();
if (!account) throw new Error('Firebase CLIでログインしてください');
await requireAuth({ project: projectId, user: account.user, tokens: account.tokens });
const requiredApis = ['recaptchaenterprise.googleapis.com', 'firebaseappcheck.googleapis.com'];
const apiStates = Object.fromEntries(await Promise.all(requiredApis.map(async api => [api, execute ? await ensure(projectId, api, 'App Check', true).then(() => true) : await check(projectId, api, 'App Check', true)])));
const apiEnabled = Object.values(apiStates).every(Boolean);
if (!apiEnabled) {
  console.log(JSON.stringify({ ok: true, mode: 'dry-run', projectId, apiEnabled: false, apiStates, existingKeys: 0, siteKey: null, appConfigured: false, enforcementMode: 'UNSPECIFIED' }));
  process.exit(0);
}
if (execute) await generateServiceIdentityAndPoll(projectNumber, 'firebaseappcheck.googleapis.com', 'App Check');
const recaptcha = new Client({ urlPrefix: 'https://recaptchaenterprise.googleapis.com', auth: true });
const appCheck = new Client({ urlPrefix: 'https://firebaseappcheck.googleapis.com', auth: true });
const keysResponse = await recaptcha.get(`/v1/projects/${projectId}/keys`);
const keys = Array.isArray(keysResponse.body?.keys) ? keysResponse.body.keys : [];
let key = keys.find(item => item.displayName === 'Electric Chair Duel App Check');
if (!key && execute) {
  key = (await recaptcha.post(`/v1/projects/${projectId}/keys`, {
    displayName: 'Electric Chair Duel App Check',
    webSettings: { allowedDomains: [`${projectId}.web.app`, `${projectId}.firebaseapp.com`], allowAmpTraffic: false, integrationType: 'SCORE' }
  })).body;
}
const siteKey = key?.name?.split('/').at(-1) || null;
const configPath = `/v1/projects/${projectNumber}/apps/${appId}/recaptchaEnterpriseConfig`;
let config = null;
try { config = (await appCheck.get(configPath)).body; } catch (error) { if (!String(error?.message || '').includes('404')) throw error; }
if (execute && siteKey && config?.siteKey !== siteKey) {
  config = (await appCheck.patch(`${configPath}?updateMask=siteKey,tokenTtl`, { name: `projects/${projectNumber}/apps/${appId}/recaptchaEnterpriseConfig`, siteKey, tokenTtl: '3600s' })).body;
}
const service = (await appCheck.get(`/v1/projects/${projectNumber}/services/firebasedatabase.googleapis.com`)).body;
console.log(JSON.stringify({ ok: true, mode: execute ? 'execute' : 'dry-run', projectId, apiEnabled: true, apiStates, existingKeys: keys.length, siteKey, appConfigured: config?.siteKey === siteKey && Boolean(siteKey), enforcementMode: service?.enforcementMode || service?.enforcementState || 'UNSPECIFIED' }));
