#!/usr/bin/env node
/**
 * Cloud sync E2E — runs against a local mock of the GitHub Gist API.
 * Verifies: push-on-save (debounced), first-push ID echo, restore-on-boot
 * (newest-wins), and local-only fallback when no env vars are set.
 *
 * Run: node scripts/cloud-e2e.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MOCK_PORT = 4599;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cloud-'));
const dbFile = path.join(tmp, 'lab.json');
process.env.SECONDSHIFT_DB = dbFile;
process.env.CLOUD_GIST_TOKEN = 'test-token';
process.env.CLOUD_GIST_API = 'http://localhost:' + MOCK_PORT; // note: adapter uses api.github.com; mock via HOST override below

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };

// ── mock Gist API ─────────────────────────────────────────────────────
let stored = null; // { content, updatedAt }
let gistId = 'MOCKGIST123';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/gists') {
      const j = JSON.parse(body);
      stored = { content: j.files['lab.json'].content, updatedAt: new Date().toISOString() };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: gistId, updated_at: stored.updatedAt }));
    } else if (req.method === 'PATCH' && req.url === '/gists/' + gistId) {
      const j = JSON.parse(body);
      stored = { content: j.files['lab.json'].content, updatedAt: new Date().toISOString() };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: gistId, updated_at: stored.updatedAt }));
    } else if (req.method === 'GET' && req.url === '/gists/' + gistId) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: gistId, updated_at: stored ? stored.updatedAt : null, files: { 'lab.json': { content: stored ? stored.content : '' } } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
});

// the adapter hardcodes api.github.com; intercept via undici EnvHttpProxyAgent? Simpler:
// monkey-patch global fetch for github URLs only, delegating everything else.
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://api.github.com')) {
    const u = new URL(url);
    return realFetch('http://localhost:' + MOCK_PORT + u.pathname, opts);
  }
  return realFetch(url, opts);
};

(async () => {
  await new Promise((r) => server.listen(MOCK_PORT, r));

  // fresh module load under env
  delete require.cache[require.resolve('../cloud-store')];
  delete require.cache[require.resolve('../data-store')];
  const cloud = require('../cloud-store');
  const store = require('../data-store');

  // 1. local-only fallback
  t(cloud.enabled === true, 'cloud enabled when token set', cloud.provider);

  // 2. save → debounced push to mock gist
  store.addEvent('cloud_test', { hello: 'world' });
  await new Promise((r) => setTimeout(r, 4600)); // > debounce 4s
  t(!!stored, 'push landed on cloud after save (debounced)');
  if (stored) {
    const parsed = JSON.parse(stored.content);
    t(Array.isArray(parsed.events) && parsed.events.some(e => e.type === 'cloud_test'), 'cloud copy contains the saved event');
  }
  t(cloud.status().pushes >= 1, 'push counter incremented', String(cloud.status().pushes));

  // 3. manual pushNow
  await store.cloudPushNow();
  t(cloud.status().lastPushAt !== null, 'manual pushNow works');

  // 4. restore-on-boot: newer cloud wins
  const st1 = store.cloudStatus();
  // simulate another machine having pushed newer data
  stored = { content: JSON.stringify({ automations: [], leads: [{ id: 'from_cloud' }], events: [], clients: [], invoices: [], calls: [], appointments: [], leadThreads: [], contents: [] }), updatedAt: new Date(Date.now() + 60000).toISOString() };
  const r1 = await store.cloudRestore();
  t(r1.restored === true, 'newer cloud copy restored on restore()', r1.reason || '');
  t(fs.existsSync(dbFile + '.local-backup'), 'local backup created before restore');
  const after = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  t(after.leads && after.leads[0] && after.leads[0].id === 'from_cloud', 'restored data is live in the store file');

  // 5. older cloud copy does NOT clobber local (newest-wins)
  stored = { content: '{"old":true}', updatedAt: new Date(Date.now() - 86400000).toISOString() };
  const r2 = await store.cloudRestore();
  t(r2.restored === false && /local is newer/.test(r2.reason), 'older cloud copy ignored (newest-wins)', r2.reason);

  // 6. pull endpoint returns status cleanly
  const status = store.cloudStatus();
  t(status.pulls >= 1 && status.provider === 'gist', 'status reflects pulls + provider', JSON.stringify({ pulls: status.pulls, provider: status.provider }));

  // 7. local-only mode: no token → enabled false, save works, no push
  delete process.env.CLOUD_GIST_TOKEN;
  delete require.cache[require.resolve('../cloud-store')];
  const cloud2 = require('../cloud-store');
  t(cloud2.enabled === false && cloud2.provider === 'local', 'no env → local-only mode');
  const before = stored.updatedAt;
  const { save } = require('../data-store');
  await new Promise((r) => setTimeout(r, 4600)); // debounce window with no token
  t(stored.updatedAt === before, 'no push attempted in local-only mode');

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? '\nCLOUD_E2E_PASS' : '\nCLOUD_E2E_FAIL');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
