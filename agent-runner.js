/**
 * SecondShift agent runner — headless Codebuff on this PC, driven from Telegram.
 *
 * Backend: @codebuff/sdk (programmatic, no TUI). Auth comes from the CLI's own
 * credentials file (~/.config/manicode/credentials.json → .default.authToken),
 * or CODEBUFF_API_KEY env if set. The account's free-tier model is used by
 * default so relay tasks don't burn paid credits:
 *   AGENT_MODEL env overrides the model without a code edit.
 *
 * Safety model (matches telegram-monitor.js):
 *   • Inert unless an auth token exists — without it every call is a no-op.
 *   • One run at a time, process-wide; new /agent requests are refused.
 *   • Hard timeout (AGENT_TIMEOUT_MS, default 8 min) — the run is abandoned
 *     and the client is torn down, so the server never hangs on a stuck agent.
 *   • The agent's instructions forbid git push, deploy, and secret exposure.
 *   • Output is truncated to a Telegram-safe size; tool chatter is dropped.
 *
 * Credits: if the Codebuff account is out of credits the API answers 402.
 * That is surfaced as a friendly "add credits" message instead of a stack trace.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── activation ─────────────────────────────────────────────────────────
let AUTH_TOKEN = process.env.CODEBUFF_API_KEY || '';
if (!AUTH_TOKEN) {
  try {
    const credPath = path.join(os.homedir(), '.config', 'manicode', 'credentials.json');
    AUTH_TOKEN = JSON.parse(fs.readFileSync(credPath, 'utf8')).default.authToken || '';
  } catch (_) { AUTH_TOKEN = ''; }
}
const enabled = !!AUTH_TOKEN;

// ── tuning ─────────────────────────────────────────────────────────────
const REPO_ROOT = path.resolve(__dirname);
const AGENT_MODEL = process.env.AGENT_MODEL || 'glm-5.3-flash-2026-09-05';
const TIMEOUT_MS = (() => { const n = parseInt(process.env.AGENT_TIMEOUT_MS, 10); return n > 0 ? n : 8 * 60 * 1000; })();
const REPLY_MAX = 3600; // Telegram limit is 4096

const state = {
  running: false, startedAt: null, lastTask: null,
  lastFinishedAt: null, lastOk: null, lastDurationMs: null, lastError: null,
  runs: 0, failed: 0,
};

const SYSTEM_RULES =
  'You are the SecondShift ops agent working on the local repository at this cwd. ' +
  'It belongs to Rishi Raj Singh (one-person AI-automation SaaS). ' +
  'Complete the requested task efficiently: search and read the relevant files, make focused edits, and run quick verification commands. ' +
  'HARD RULES: never run git push/commit, never deploy, never delete data files, never print secrets or API keys, keep changes minimal. ' +
  'Finish with a short plain-text summary (max ~12 lines) of what you did or found.';

/** Parse the SDK's failure shapes into short human sentences. */
function describeError(err) {
  const s = String((err && (err.message || err.toString())) || err);
  if (s.includes('Payment Required') || s.includes('Out of credits') || s.includes('402')) {
    return 'Codebuff account is out of credits — top up at https://www.codebuff.com/usage (then /agent works immediately).';
  }
  if (s.includes('401') || s.includes('Unauthorized') || s.includes('Invalid API key')) {
    return 'Codebuff auth rejected — run `npx codebuff login` again on the PC, or set CODEBUFF_API_KEY.';
  }
  if (s.includes('aborted') || s.includes('timeout')) return 'Agent timed out after ' + Math.round(TIMEOUT_MS / 60000) + ' min — task abandoned, server unharmed.';
  return s.slice(0, 240);
}

/** Extract plain text output from the RunState result. */
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

/**
 * runTask(taskText, { onUpdate }) — the single entry point.
 *  onUpdate(statusText)  fire-and-forget progress notices.
 *  Resolves { ok, text, durationMs } — never throws.
 */
async function runTask(taskText, { onUpdate = () => {} } = {}) {
  if (!enabled) return { ok: false, text: 'Agent runner not activated (no Codebuff auth found on this PC).', durationMs: 0 };
  if (state.running) return { ok: false, text: '⏳ Another agent task is still running (' + state.lastTask + ') — /agentstatus to check, wait for it to finish.', durationMs: 0 };

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.lastTask = String(taskText).slice(0, 200);
  state.lastError = null;
  const t0 = Date.now();

  let client = null;
  try {
    // Lazy require so the server boots even if the SDK install is broken.
    const { CodebuffClient } = require('@codebuff/sdk');
    client = new CodebuffClient({ apiKey: AUTH_TOKEN, cwd: REPO_ROOT });

    const agent = {
      id: 'secondshift-relay',
      model: AGENT_MODEL,
      displayName: 'SecondShift Relay',
      toolNames: ['read_files', 'write_file', 'code_search', 'run_terminal_command', 'end_turn'],
      instructionsPrompt: SYSTEM_RULES,
    };

    const runPromise = client.run({
      agent: agent.id,
      agentDefinitions: [agent],
      prompt: String(taskText).slice(0, 4000),
      maxAgentSteps: 40,
      handleEvent: () => {}, // tool chatter is not relayed — only the final summary
    });

    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; onUpdate('⏱ Agent hit the ' + Math.round(TIMEOUT_MS / 60000) + ' min ceiling — abandoning this run.'); client.close().catch(() => {}); }, TIMEOUT_MS);
    timer.unref && timer.unref();

    let result = null;
    try { result = await runPromise; } finally { clearTimeout(timer); }

    const durationMs = Date.now() - t0;
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
    state.lastDurationMs = durationMs;
    state.runs++;

    if (timedOut) {
      state.failed++; state.lastOk = false; state.lastError = 'timeout';
      return { ok: false, text: '⏱ Agent timed out after ' + Math.round(TIMEOUT_MS / 60000) + ' min — run abandoned. Partial work may exist on disk; review with /health or ask me to inspect.', durationMs };
    }

    const out = result && result.output;
    if (out && out.type === 'error') {
      state.failed++; state.lastOk = false; state.lastError = out.message || 'run error';
      return { ok: false, text: '❌ Agent failed: ' + describeError({ message: out.message }), durationMs };
    }

    const text = extractText(result).trim();
    state.lastOk = true;
    return { ok: true, text: ('🤖 Done in ' + Math.round(durationMs / 1000) + 's\n\n' + (text || '(agent finished without a summary)')).slice(0, REPLY_MAX), durationMs };
  } catch (err) {
    const durationMs = Date.now() - t0;
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
    state.lastDurationMs = durationMs;
    state.runs++; state.failed++;
    state.lastOk = false;
    state.lastError = describeError(err);
    return { ok: false, text: '❌ Agent failed: ' + state.lastError, durationMs };
  } finally {
    if (client) { try { client.close(); } catch (_) {} }
  }
}

function status() {
  return { enabled, model: AGENT_MODEL, running: state.running, startedAt: state.startedAt,
    lastTask: state.lastTask, lastFinishedAt: state.lastFinishedAt, lastOk: state.lastOk,
    lastDurationMs: state.lastDurationMs, lastError: state.lastError, runs: state.runs, failed: state.failed };
}

module.exports = { enabled, runTask, status, AGENT_MODEL, TIMEOUT_MS };
