#!/usr/bin/env node
/**
 * Public-surface guard — fails if anything a visitor can see leaks back in.
 *
 * The site is demoed to clients, so the visitor-facing surface must never name
 * the stack (voice/vendor names, containers, tunnels, env vars), expose the
 * admin password, or ship a secret. This test greps the shipped assets and the
 * content the API serves, and checks the files that should not exist.
 *
 * Run: node scripts/test-public-surface.js
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };

const read = (p) => fs.readFileSync(p, 'utf8');
const htmlFiles = fs.readdirSync(PUB).filter((f) => /\.(html|js|css)$/.test(f));

// The voice engine's loader has to name the package/model it pulls from the CDN
// — a functional identifier, not copy. Those lines are stripped before the scan
// so the guard still catches the name in labels, comments, warnings and prose.
const LOADER_PLUMBING = /cdn\.jsdelivr\.net|MODEL_ID\s*=|from_pretrained/;
const stripLoader = (text) => text.split('\n').filter((l) => !LOADER_PLUMBING.test(l)).join('\n');

const assets = htmlFiles.map((f) => ({ name: f, text: stripLoader(read(path.join(PUB, f))) }));

// ── 1 — copy that must never appear in shipped assets ──────────────────
// Only strings that would be RENDERED or read as copy — internal identifiers
// (element ids like vapiBox, css classes like .vb-dot.kokoro, function names)
// are deliberately allowed, so each pattern targets visible phrasing.
const FORBIDDEN_COPY = [
  { re: /lab-admin-2026/, why: 'the admin password' },
  { re: /Default password/i, why: 'an admin password hint' },
  { re: /\bClaude\b/, why: 'a vendor name in copy' },
  { re: /Kokoro[- ](82M|neural)/i, why: 'the voice engine name' },
  { re: /Pro line: Vapi|Vapi · |Free line: Dograh/i, why: 'vendor names in the voice panel' },
  { re: /Docker stack|tunnel URLs|VOICE-DOGRAH\.md|VOICE-VAPI\.md|VOICE-AGENT\.md/i, why: 'runbook / infra instructions' },
  { re: /ADMIN_PASSWORD|OPENROUTER_API_KEY|VAPI_ASSISTANT_ID|CLOUD_GIST_TOKEN|TELEGRAM_BOT_TOKEN/, why: 'env var names' },
  { re: /trycloudflare\.com/, why: 'a tunnel hostname' },
  { re: /live backend/i, why: 'backend jargon' },
  { re: /POS webhook|webhook received|fires a webhook/i, why: 'webhook jargon' },
];
for (const { re, why } of FORBIDDEN_COPY) {
  const hits = assets.filter((a) => re.test(a.text)).map((a) => a.name);
  t(hits.length === 0, 'no ' + why + ' in shipped assets', hits.join(', ') || 'clean');
}

// ── 2 — no secret shapes anywhere in the shipped assets ────────────────
const SECRET_SHAPES =
  /sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|\b\d{8,10}:[A-Za-z0-9_-]{30,}\b|BEGIN [A-Z ]*PRIVATE KEY/;
const secretHits = assets.filter((a) => SECRET_SHAPES.test(a.text)).map((a) => a.name);
t(secretHits.length === 0, 'no API-key/token shapes in shipped assets', secretHits.join(', ') || 'clean');

// ── 3 — internal-only files are gone / never served ────────────────────
t(!fs.existsSync(path.join(PUB, 'dograh-test.html')), 'the internal widget test page is gone');
t(/app\.use\('\/dograh-endpoints\.json'/.test(read(path.join(ROOT, 'server.js'))),
  'server blocks the tunnel-endpoints file from being served');

// ── 4 — the copy that feeds the site is clean too ─────────────────────
const seed = read(path.join(ROOT, 'scripts', 'seed.js'));
t(!/\bClaude\b|webhook/i.test(seed), 'seed copy has no vendor names or webhook jargon',
  (seed.match(/Claude|webhook/gi) || []).join(', ') || 'clean');

// ── 5 — what the running server actually serves over HTTP ──────────────
// Uses node:http (not global fetch) so the process exits cleanly on Windows.
const httpGet = (urlPath) =>
  new Promise((resolve) => {
    const req = http.get({ host: 'localhost', port: 4000, path: urlPath, timeout: 3000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });

(async () => {
  const JARGON = /claude|webhook|vapi|kokoro|docker|api key|n8n|postgres|\bLLM\b|trycloudflare|OPENROUTER/gi;
  const autos = await httpGet('/api/automations');
  if (!autos) {
    console.log('SKIP  live API checks (server not running)');
  } else {
    const jargon = autos.body.match(JARGON) || [];
    t(jargon.length === 0, 'served automation content is clean', [...new Set(jargon)].join(', ') || 'clean');

    // Every public payload the site fetches, checked for stack/vendor leaks
    // and for anything resembling a real credential.
    // (/api/dograh/config is deliberately absent here — its URLs are the one
    // functional exception; it gets the stricter URL-stripped audit below.)
    for (const route of ['/api/config', '/api/voice/config', '/api/vapi/config', '/api/health']) {
      const r = await httpGet(route);
      if (!r) { console.log('SKIP  ' + route + ' (no answer)'); continue; }
      const hits = (r.body.match(JARGON) || []);
      t(hits.length === 0, 'no stack/vendor names in ' + route, [...new Set(hits)].join(', ') || 'clean');
      t(!SECRET_SHAPES.test(r.body), 'no credential shapes in ' + route);
    }

    // The free line is the one documented exception: a visitor's browser has to
    // fetch the widget straight from the tunnel and authenticate with its embed
    // token, so those fields are functional, not decoration. What must hold is
    // that no real secret rides along and the key set stays exactly this — if a
    // future edit adds a field (an API key, a DB URL), this guard fails.
    const dograh = await httpGet('/api/dograh/config');
    if (!dograh) {
      console.log('SKIP  free-line config key audit (no answer)');
    } else {
      let cfg = null;
      try { cfg = JSON.parse(dograh.body); } catch (_) {}
      t(!!cfg, 'free-line config is valid JSON');
      // Strip the two URL values themselves, then scan the rest of the payload:
      // a tunnel host mentioned in any OTHER field (or a message) is a leak.
      const rest = dograh.body.replace(/https:\/\/[^"\s]+/g, '"<url>"');
      const leaks = rest.match(JARGON) || [];
      t(leaks.length === 0, 'free-line config names the stack nowhere but its URLs', [...new Set(leaks)].join(', ') || 'clean');
      if (cfg) {
        const allowed = ['configured', 'token', 'uiUrl', 'apiUrl'];
        const extra = Object.keys(cfg).filter((k) => !allowed.includes(k));
        t(extra.length === 0, 'free-line config exposes only the widget fields it needs', extra.join(', ') || allowed.join('/'));
        const urls = [cfg.uiUrl, cfg.apiUrl].filter(Boolean);
        t(urls.every((u) => /^https:\/\//.test(u)), 'free-line URLs are https only');
      }
    }

    // The tunnel-endpoints file and the internal test page must not be reachable.
    for (const secretPath of ['/dograh-endpoints.json', '/dograh-test.html']) {
      const r = await httpGet(secretPath);
      t(!r || r.status === 404, secretPath + ' returns 404 over HTTP', r ? 'status ' + r.status : 'refused');
    }

    // Framework fingerprint headers advertise the stack.
    const h = await httpGet('/');
    const xp = h && h.headers['x-powered-by'];
    t(!xp, 'no X-Powered-By stack fingerprint header', xp || 'absent');
  }

  console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exitCode = ok ? 0 : 1;
})();
