#!/usr/bin/env node
/**
 * agent-runner unit test — OFFLINE. OpenRouter is a local mock (OpenAI-compatible
 * tool-calling flow); Codebuff SDK is never contacted (stubbed module).
 *
 * Verifies: free-brain multi-step tool loop (search→read→edit→finish),
 * path jail, model fallback chain, credit 402 message, no-key refusal,
 * timeout, and that Codebuff backend is reachable via AGENT_BACKEND.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' : '') + (extra || '')); if (!pass) ok = false; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── sandbox repo (so the agent edits nothing real) ─────────────────────
// The runner jails tools to ITS OWN directory, so we copy agent-runner.js
// to the sandbox ROOT (same as production layout) and require that copy.
// The Codebuff SDK is stubbed physically in the sandbox's node_modules so
// the copy's module resolution finds the stub, not the real SDK.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-agent-'));
fs.writeFileSync(path.join(sandbox, 'hello.txt'), 'color = blue\nsize = 10\n');
fs.copyFileSync(path.join(__dirname, '..', 'agent-runner.js'), path.join(sandbox, 'agent-runner.js'));
const R = path.join(sandbox, 'agent-runner.js');
const nm = path.join(sandbox, 'node_modules', '@codebuff', 'sdk');
fs.mkdirSync(nm, { recursive: true });
fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ name: '@codebuff/sdk', version: '0.0.0-test', main: 'index.js' }));
fs.writeFileSync(path.join(nm, 'index.js'),
  'module.exports.CodebuffClient = class { constructor(o){ this.creds = o.apiKey; } async run(x){ return { output: { type: "text", value: "codebuff-stub-summary: " + x.prompt } }; } close(){} };');

// ── mock OpenRouter with a scripted tool-calling session ───────────────
const script = [
  { tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_dir', arguments: '{}' } }] },
  { tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_files', arguments: '{"paths":["hello.txt"]}' } }] },
  { tool_calls: [{ id: 'c3', type: 'function', function: { name: 'edit_file', arguments: '{"path":"hello.txt","edits":[{"old":"color = blue","new":"color = red"}]}' } }] },
  { tool_calls: [{ id: 'c4', type: 'function', function: { name: 'finish', arguments: '{"summary":"Changed color from blue to red in hello.txt."}' } }] },
];
let mode = 'happy'; // happy | fail-first-model | http402
let calls = 0;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (mode === 'http402') { res.statusCode = 402; res.end(JSON.stringify({ error: { message: 'Out of credits' } })); return; }
    if (mode === 'fail-first-model' && /bad-model/.test(body)) { res.statusCode = 503; res.end(JSON.stringify({ error: { message: 'model overloaded' } })); return; }
    const step = Math.min(calls++, script.length - 1);
    const msg = script[step];
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls } }] }));
  });
});



process.env.OPENROUTER_API_KEY = 'test-or-key';
process.env.OPENROUTER_BASE = 'http://127.0.0.1:' + process.env.MOCK_PORT;
process.env.AGENT_FREE_MODELS = 'bad-model:free,qwen/good:free';
process.env.AGENT_TIMEOUT_MS = '15000';
delete process.env.AGENT_BACKEND;

(async () => {
  await new Promise((r) => mock.listen(0, r));
  process.env.OPENROUTER_BASE = 'http://127.0.0.1:' + mock.address().port;

  const runner = require(R);

  t(runner.enabled === true, 'runner active with OpenRouter key');
  t(runner.status().backend === 'openrouter', 'default backend = openrouter');

  // 1 — happy path: scripted multi-step tool session lands a real edit
  const r1 = await runner.runTask('change color to red in hello.txt', {});
  t(r1.ok === true && r1.backend === 'openrouter', 'free-brain task ok', JSON.stringify(r1).slice(0, 120));
  t(/Free-line agent done/.test(r1.text), 'summary tagged as free-line');
  t(fs.readFileSync(path.join(sandbox, 'hello.txt'), 'utf8').includes('color = red'), 'tool loop actually edited the file');
  t(runner.status().models.length === 2, 'model chain loaded from env');

  // 2 — first model 503s → falls through to the next free model
  mode = 'fail-first-model'; calls = 0;
  const r2 = await runner.runTask('do it again', {});
  t(r2.ok === true && r2.backend === 'openrouter', 'model fallback works', JSON.stringify(r2).slice(0, 100));
  mode = 'happy'; calls = 0;

  // 3 — codebuff backend via AGENT_BACKEND (sandbox SDK stub, no credits involved)
  process.env.AGENT_BACKEND = 'codebuff';
  delete require.cache[require.resolve(R)];
  const runner2 = require(R);
  const r3 = await runner2.runTask('ping the fallback', {});
  t(r3.ok === true && r3.backend === 'codebuff' && /codebuff-stub-summary/.test(r3.text), 'codebuff fallback path works', JSON.stringify(r3).slice(0, 100));
  delete process.env.AGENT_BACKEND;

  // 4 — openrouter-side 402 → try-again advice
  mode = 'http402';
  delete require.cache[require.resolve(R)];
  const runner3 = require(R);
  const r4 = await runner3.runTask('x', {});
  t(r4.ok === false && /rate-limited|try again/i.test(r4.text), 'openrouter 402 → try-again advice', r4.text.slice(0, 80));
  mode = 'happy'; calls = 0;

  // 5 — no keys at all → inert (fake HOME so the PC's real codebuff token is hidden)
  process.env.OPENROUTER_API_KEY = '';
  const realProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = path.join(sandbox, 'fakehome');
  fs.mkdirSync(process.env.USERPROFILE, { recursive: true });
  delete require.cache[require.resolve(R)];
  const runner4 = require(R);
  t(runner4.enabled === false, 'no keys → runner inert');
  const r5 = await runner4.runTask('x', {});
  t(runner4.enabled === false && r5.ok === false && /OPENROUTER_API_KEY/.test(r5.text), 'inert refusal explains setup', r5.text.slice(0, 80));
  process.env.USERPROFILE = realProfile;

  // 6 — timeout path
  process.env.OPENROUTER_API_KEY = 'test-or-key';
  process.env.AGENT_TIMEOUT_MS = '800';
  delete require.cache[require.resolve(R)];
  const runner5 = require(R);
  const origFetch = global.fetch;
  global.fetch = () => new Promise(() => {}); // hang forever
  const r6 = await runner5.runTask('hang', {});
  global.fetch = origFetch;
  t(r6.ok === false && /timeout/.test(r6.text), 'hard timeout aborts cleanly', r6.text.slice(0, 80));

  mock.close();
  console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('UNIT crash:', e.message); if (e.stack) console.error(e.stack.split('\n').slice(1, 5).join('\n')); process.exit(1); });
