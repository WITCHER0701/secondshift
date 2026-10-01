/**
 * SecondShift agent runner — the Telegram /agent backend on this PC.
 *
 * Two brains, chosen automatically:
 *   1. OpenRouter (default when OPENROUTER_API_KEY is set): a local agent loop
 *      over FREE models (no Codebuff credits involved). Chain + fallback:
 *      AGENT_FREE_MODELS env (comma-separated) or the built-in default chain.
 *      Set OPENROUTER_BASE to point at a mock for testing.
 *   2. Codebuff SDK (fallback, or AGENT_BACKEND=codebuff): headless
 *      programmatic runs with the CLI's saved auth. Needs Codebuff credits —
 *      if they run out you get a friendly top-up pointer, never a crash.
 *
 * Safety model (matches telegram-monitor.js):
 *   • Inert without any auth (no OpenRouter key AND no Codebuff token).
 *   • One run at a time, process-wide; new /agent requests are refused.
 *   • Hard timeout (AGENT_TIMEOUT_MS, default 8 min) — the run is abandoned.
 *   • The system rules forbid git push, deploy, and secret exposure.
 *   • Output is truncated to a Telegram-safe size.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── auth: OpenRouter first, Codebuff as fallback ───────────────────────
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OR_BASE = (process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
let CB_TOKEN = process.env.CODEBUFF_API_KEY || '';
if (!CB_TOKEN) {
  try {
    CB_TOKEN = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'manicode', 'credentials.json'), 'utf8')).default.authToken || '';
  } catch (_) { CB_TOKEN = ''; }
}
const enabled = !!(OR_KEY || CB_TOKEN);

// ── tuning ─────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname);
const BACKEND = (process.env.AGENT_BACKEND || '').toLowerCase(); // '' | 'openrouter' | 'codebuff'
const TIMEOUT_MS = (() => { const n = parseInt(process.env.AGENT_TIMEOUT_MS, 10); return n > 0 ? n : 8 * 60 * 1000; })();
const REPLY_MAX = 3600;
const FREE_MODELS = (process.env.AGENT_FREE_MODELS ||
  'qwen/qwen3.8-27b:free,cohere/north-mini-code:free,nvidia/nemotron-3-super-120b-a12b:free,google/gemma-4-31b-it:free,poolside/laguna-s-2.1:free')
  .split(',').map((s) => s.trim()).filter(Boolean);
const CALL_TIMEOUT_MS = parseInt(process.env.AGENT_CALL_TIMEOUT_MS, 10) || 45000; // per model call — Telegram users wait
const MAX_STEPS = parseInt(process.env.AGENT_MAX_STEPS, 10) || 30;

const state = {
  running: false, startedAt: null, lastTask: null, lastBackend: null,
  lastFinishedAt: null, lastOk: null, lastDurationMs: null, lastError: null,
  runs: 0, failed: 0,
};

const SYSTEM_RULES =
  'You are the SecondShift ops agent working on the local repository at this cwd. ' +
  'It belongs to Rishi Raj Singh (one-person AI-automation SaaS). ' +
  'Complete the requested task efficiently: search and read the relevant files, make focused edits, and run quick verification commands. ' +
  'HARD RULES: never run git push/commit, never deploy, never delete data files, never print secrets or API keys, keep changes minimal. ' +
  'Finish with a short plain-text summary (max ~12 lines) of what you did or found.';

function describeError(err) {
  const s = String((err && (err.message || err.toString())) || err);
  if (/openrouter 402|Out of credits|Payment Required|402/.test(s)) {
    return s.includes('openrouter')
      ? 'OpenRouter free pool is rate-limited/exhausted right now — try again in a minute, or add a paid model to AGENT_FREE_MODELS.'
      : 'Codebuff account is out of credits — set OPENROUTER_API_KEY (free) in .env to use free models, or top up at https://www.codebuff.com/usage.';
  }
  if (s.includes('401') || s.includes('403') || s.includes('Unauthorized') || s.includes('Invalid API key')) {
    return 'Auth rejected — check OPENROUTER_API_KEY in .env, or run `npx codebuff login` to refresh the Codebuff token.';
  }
  if (s.includes('aborted') || s.includes('timeout')) return 'Agent timed out after ' + Math.round(TIMEOUT_MS / 60000) + ' min — task abandoned, server unharmed.';
  return s.slice(0, 240);
}

function extractText(result) {
  if (!result) return '';
  const o = result.output;
  if (typeof o === 'string') return o;
  if (o && typeof o === 'object') {
    if (typeof o.text === 'string' && o.text) return o.text;
    if (o.type === 'text' && typeof o.value === 'string') return o.value;
    if (o.type === 'error') return '';
    try { return JSON.stringify(o); } catch (_) { return String(o); }
  }
  return '';
}

// ══ Brain 1: OpenRouter local agent loop (free models) ════════════════
const TOOLS = [
  { type: 'function', function: { name: 'read_files', description: 'Read one or more files from the repo.', parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Relative file paths' } }, required: ['paths'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file with complete new content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace exact strings in a file. Provide pairs of old/new strings.', parameters: { type: 'object', properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', properties: { old: { type: 'string' }, new: { type: 'string' } }, required: ['old', 'new'] } } }, required: ['path', 'edits'] } } },
  { type: 'function', function: { name: 'list_dir', description: 'List files and folders in a directory.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative dir, default .' } } } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a quick shell command (search/read-only preferred). Returns stdout/stderr trimmed to 3000 chars.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'finish', description: 'End the task with a short summary for the owner.', parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } } },
];

// Tools run synchronously (execFileSync) to keep the agent loop simple;
// every path is jailed to the repo root.
const { execFileSync } = require('child_process');
function runToolSync(name, args) {
  const rel = (p) => {
    const abs = path.resolve(REPO_ROOT, String(p || '.'));
    if (!abs.startsWith(REPO_ROOT)) throw new Error('outside repo: ' + p);
    return abs;
  };
  try {
    if (name === 'read_files') {
      const out = {};
      for (const p of (args.paths || []).slice(0, 8)) {
        try { out[p] = fs.readFileSync(rel(p), 'utf8').slice(0, 12000); } catch (e) { out[p] = 'ERROR: ' + e.message; }
      }
      return JSON.stringify(out);
    }
    if (name === 'write_file') {
      const abs = rel(args.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(args.content ?? ''));
      return 'wrote ' + args.path + ' (' + String(args.content ?? '').length + ' chars)';
    }
    if (name === 'edit_file') {
      const abs = rel(args.path);
      let txt = fs.readFileSync(abs, 'utf8');
      let n = 0;
      for (const e of (args.edits || [])) {
        if (!txt.includes(e.old)) return 'EDIT FAILED: string not found in ' + args.path + ': ' + String(e.old).slice(0, 80);
        txt = txt.split(e.old).join(e.new); n++;
      }
      fs.writeFileSync(abs, txt);
      return 'applied ' + n + ' edit(s) to ' + args.path;
    }
    if (name === 'list_dir') {
      const abs = rel(args.path || '.');
      return fs.readdirSync(abs, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name)).slice(0, 200).join('\n');
    }
    if (name === 'run_command') {
      const out = execFileSync('bash', ['-c', String(args.command || '')],
        { cwd: REPO_ROOT, timeout: 30000, maxBuffer: 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return String(out || '(no output)').slice(0, 3000);
    }
    if (name === 'finish') return '__FINISH__';
  } catch (e) {
    const msg = String((e && (e.message || e.stderr)) || e).slice(0, 300);
    if (name === 'run_command') return 'COMMAND FAILED: ' + msg; // model can react and retry
    return 'TOOL ERROR: ' + msg;
  }
  return 'unknown tool ' + name;
}

async function chatOnce(model, messages) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetch(OR_BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + OR_KEY },
      body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto' }),
      signal: ac.signal,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('openrouter ' + res.status + ' ' + ((j.error && j.error.message) || '').slice(0, 120));
    const m = j.choices && j.choices[0] && j.choices[0].message;
    if (!m || typeof m !== 'object') throw new Error('model ' + model + ' returned an empty message — treating as model failure');
    return m;
  } finally { clearTimeout(to); }
}

async function runOpenRouter(task, { onUpdate }) {
  const t0 = Date.now();
  const reserve = Math.min(20000, Math.floor(TIMEOUT_MS * 0.25)); // leave room for a clean reply
  const budgetExceeded = () => Date.now() - t0 > TIMEOUT_MS - reserve;
  const messages = [
    { role: 'system', content: SYSTEM_RULES + '\nRepo root is the cwd. Use the tools to inspect and change files. Call finish when done.' },
    { role: 'user', content: String(task).slice(0, 4000) },
  ];
  let lastErr = null;
  for (const model of FREE_MODELS) {
    if (budgetExceeded()) break;
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (budgetExceeded()) throw new Error('aborted by timeout');
        let msg;
        try {
          msg = await chatOnce(model, messages);
        } catch (e) {
          if (/429|rate/.test(String((e && e.message) || e))) await new Promise((r) => setTimeout(r, 4000)); // brief backoff, then next model via outer catch
          throw e;
        }
        messages.push(msg); // guaranteed non-null by chatOnce
        const calls = msg.tool_calls || [];
        if (!calls.length) return (msg.content || '').trim() || '(model finished without a summary)';
        const toolMsgs = [];
        let finished = null;
        for (const c of calls) {
          if (c.function && c.function.name === 'finish') {
            finished = (JSON.parse(c.function.arguments || '{}').summary || '').slice(0, REPLY_MAX);
            toolMsgs.push({ role: 'tool', tool_call_id: c.id, content: 'ok' });
            continue;
          }
          let args = {};
          try { args = JSON.parse(c.function.arguments || '{}'); } catch (_) { /* tolerate */ }
          const result = runToolSync(c.function.name, args);
          toolMsgs.push({ role: 'tool', tool_call_id: c.id, content: String(result).slice(0, 6000) });
        }
        messages.push(...toolMsgs);
        if (finished != null) return finished || '(agent finished)';
      }
      return '(hit the step ceiling before finishing — partial work may exist on disk)';
    } catch (e) {
      if (/aborted by timeout/.test(String((e && e.message) || e))) throw e; // out of total budget — stop the chain
      lastErr = e;
      onUpdate('⚠ model ' + model + ' failed (' + String((e && e.message) || e).slice(0, 80) + ') — trying the next free model');
    }
  }
  if (budgetExceeded()) throw new Error('aborted by timeout');
  throw lastErr || new Error('all free models failed — the free pool is busy right now, try again in a minute');
}

// ══ Brain 2: Codebuff SDK (credits / fallback) ════════════════════════
async function runCodebuff(task, { onUpdate }) {
  const { CodebuffClient } = require('@codebuff/sdk');
  const client = new CodebuffClient({ apiKey: CB_TOKEN, cwd: REPO_ROOT });
  const agent = {
    id: 'secondshift-relay',
    model: process.env.AGENT_MODEL || 'glm-5.3-flash-2026-09-05',
    displayName: 'SecondShift Relay',
    toolNames: ['read_files', 'write_file', 'code_search', 'run_terminal_command', 'end_turn'],
    instructionsPrompt: SYSTEM_RULES,
  };
  try {
    const runPromise = client.run({
      agent: agent.id, agentDefinitions: [agent],
      prompt: String(task).slice(0, 4000), maxAgentSteps: 40, handleEvent: () => {},
    });
    const timer = setTimeout(() => { onUpdate('⏱ hitting the time ceiling — abandoning run'); client.close().catch(() => {}); }, TIMEOUT_MS);
    timer.unref && timer.unref();
    let result = null;
    try { result = await runPromise; } finally { clearTimeout(timer); }
    const out = result && result.output;
    if (out && out.type === 'error') throw { message: out.message || 'run error' };
    return (extractText(result).trim() || '(agent finished without a summary)').slice(0, REPLY_MAX);
  } finally { try { client.close(); } catch (_) {} }
}

/**
 * runTask(taskText, { onUpdate }) — the single entry point.
 * Resolves { ok, text, durationMs, backend } — never throws.
 */
async function runTask(taskText, { onUpdate = () => {} } = {}) {
  if (!enabled) return { ok: false, backend: null, text: 'Agent runner not activated — set OPENROUTER_API_KEY (free) in .env, or run `npx codebuff login`.', durationMs: 0 };
  if (state.running) return { ok: false, backend: null, text: '⏳ Another agent task is still running ("' + state.lastTask + '") — /agentstatus to check.', durationMs: 0 };

  const backend = BACKEND === 'codebuff' || BACKEND === 'openrouter' ? BACKEND : (OR_KEY ? 'openrouter' : 'codebuff');
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.lastTask = String(taskText).slice(0, 200);
  state.lastBackend = backend;
  state.lastError = null;
  const t0 = Date.now();

  let timeoutId = null;
  try {
    const work = backend === 'openrouter' ? runOpenRouter(taskText, { onUpdate }) : runCodebuff(taskText, { onUpdate });
    const timeoutPromise = new Promise((_, rej) => {
      timeoutId = setTimeout(() => rej(Object.assign(new Error('aborted by timeout'))), TIMEOUT_MS);
      if (timeoutId.unref) timeoutId.unref();
    });
    const summary = await Promise.race([work, timeoutPromise]);
    const durationMs = Date.now() - t0;
    state.running = false; state.lastFinishedAt = new Date().toISOString();
    state.lastDurationMs = durationMs; state.runs++; state.lastOk = true;
    const tag = backend === 'openrouter' ? '🤖 Free-line agent done in ' + Math.round(durationMs / 1000) + 's' : '🤖 Codebuff agent done in ' + Math.round(durationMs / 1000) + 's';
    return { ok: true, backend, durationMs, text: (tag + '\n\n' + summary).slice(0, REPLY_MAX) };
  } catch (err) {
    const durationMs = Date.now() - t0;
    state.running = false; state.lastFinishedAt = new Date().toISOString();
    state.lastDurationMs = durationMs; state.runs++; state.failed++; state.lastOk = false;
    state.lastError = /aborted by timeout/.test(String((err && err.message) || err)) ? 'timeout after ' + Math.round(TIMEOUT_MS / 60000) + 'm' : describeError(err);
    return { ok: false, backend, durationMs, text: '❌ Agent failed: ' + state.lastError };
  } finally { if (timeoutId) clearTimeout(timeoutId); }
}

function status() {
  return { enabled, backend: BACKEND || (OR_KEY ? 'openrouter' : 'codebuff'), models: FREE_MODELS,
    running: state.running, startedAt: state.startedAt, lastTask: state.lastTask,
    lastFinishedAt: state.lastFinishedAt, lastOk: state.lastOk,
    lastDurationMs: state.lastDurationMs, lastError: state.lastError, runs: state.runs, failed: state.failed };
}

module.exports = { enabled, runTask, status, AGENT_MODEL: process.env.AGENT_MODEL || 'glm-5.3-flash-2026-09-05', TIMEOUT_MS, FREE_MODELS };
