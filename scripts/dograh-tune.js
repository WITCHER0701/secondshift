#!/usr/bin/env node
/**
 * dograh-tune.js — tune the live Dograh agent for Indian AND international callers.
 *
 * The free line runs Dograh on this PC. Two things decide how it hears and
 * treats callers, and both live in Dograh's database:
 *
 *   - the voice brain: STT language, voice, speed
 *     → organization_configurations / MODEL_CONFIGURATION_V2
 *   - the behaviour: prompts for the start / agenda / global layers
 *     → workflow_definitions / workflow_json
 *
 * This tool edits both from the outside: a backup is written first, the write
 * is dry-run unless you pass --apply, and the API container is restarted so the
 * agent picks the change up. Nothing else in the stack is touched.
 *
 * Usage:
 *   node scripts/dograh-tune.js show
 *   node scripts/dograh-tune.js language india                 # dry run
 *   node scripts/dograh-tune.js language india --apply         # en-IN + restart
 *   node scripts/dograh-tune.js language international --apply # plain English
 *   node scripts/dograh-tune.js language multilingual --apply  # auto (en+hi+8)
 *   node scripts/dograh-tune.js prompts --apply                # India + intl behaviour
 *   node scripts/dograh-tune.js restore                        # undo last change
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DOGRAH_ENV = path.join(ROOT, 'dograh', '.env');
const BACKUP = path.join(ROOT, 'dograh-tune.backup.json');
const PG_CONTAINER = 'dograh-postgres-1';
const API_CONTAINER = 'dograh-api-1';
const CONFIG_KEY = 'MODEL_CONFIGURATION_V2';

// ── presets: one line to switch the free line between markets ──────────
const LANGUAGE_PRESETS = {
  india: { code: 'en-IN', label: 'India — Indian English (Deepgram en-IN)' },
  international: { code: 'en', label: 'International — accent-agnostic English' },
  multilingual: { code: 'multi', label: 'Multilingual auto-detect (en + hi + 8 more)' },
};
// what "multi" can actually auto-detect in Dograh's managed pipeline
const MULTI_LANGUAGES = ['de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'nl', 'pt', 'ru'];

const PROMPT_MARKER = '## ACCENT & MARKET HANDLING';
const PROMPT_SECTION = `${PROMPT_MARKER} (India + international)

You talk to callers from India and from around the world. Handle both naturally.

### Who is calling
- Match the caller's language: reply in English, Hindi or Hinglish exactly as they speak to you. Never ask a caller to switch to English.
- Indian-English phrasing is normal speech, never an error: "kindly", "do the needful", "day after tomorrow", "4 o'clock", "same to same". Never ask a caller to repeat because of wording.
- For callers from outside India, keep a neutral English tone and leave out India-specific references (rupees, IST, festivals) unless the caller raises them first.

### Numbers, money and time
- Indian numbers are usually 10 digits, often said digit by digit and sometimes with a +91 prefix. Read them back once, grouped, so a wrong digit can be corrected.
- Money may come as rupees, "lakh" or "crore". Treat 1 lakh = 100,000 and 1 crore = 10,000,000.
- If a time is ambiguous, confirm it in words ("4 in the evening") instead of 24-hour format.

### Unchanged
- Keep replies short (10-25 words), one question at a time.
- Never mention accents, transcription, or that you are a model.`;

// ── tiny shell helper (args array — no shell quoting pitfalls) ─────────
function run(cmd, args, { input } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: 1, out: '', err: String(e.message) }); }
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: 1, out, err: err + String(e.message) }));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    if (input != null) { try { child.stdin.end(input); } catch (_) {} } else { try { child.stdin.end(); } catch (_) {} }
  });
}

function pgPassword() {
  try {
    const line = fs.readFileSync(DOGRAH_ENV, 'utf8').split(/\r?\n/).find((l) => /^\s*POSTGRES_PASSWORD\s*=/.test(l));
    return line ? line.split('=').slice(1).join('=').replace(/^"|"$/g, '').trim() : '';
  } catch (_) { return ''; }
}

/** Run one SQL statement against the Dograh database (read or write). */
async function psql(sql) {
  const r = await run('docker', ['exec', '-i', '-e', 'PGPASSWORD=' + pgPassword(), PG_CONTAINER,
    'psql', '-U', 'postgres', '-d', 'postgres', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
  if (r.code !== 0) throw new Error('psql failed: ' + (r.err || r.out).slice(0, 300));
  return r.out;
}

/** Dollar-quote a JSON payload so no escaping games are needed. */
function quoteJson(jsonText, tag) { return `$${tag}$${jsonText}$${tag}$`; }

// ── pure helpers (unit-tested offline) ────────────────────────────────
/** Merge a new STT language into a MODEL_CONFIGURATION_V2 object, keeping the key. */
function withLanguage(cfg, code) {
  const next = JSON.parse(JSON.stringify(cfg || {}));
  const dograh = next.dograh || {};
  return { ...next, mode: next.mode || 'dograh', version: next.version || 2, dograh: { ...dograh, language: code } };
}

/** Add the India + international section to the agent's global prompt (idempotent). */
function withIndiaPrompts(workflowJson) {
  const wf = JSON.parse(JSON.stringify(workflowJson || {}));
  const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
  // the global/personality layer is the node that opens with "# OVERALL GOAL"
  const target = nodes.find((n) => n && n.data && typeof n.data.prompt === 'string' && /^#\s*OVERALL GOAL/i.test(n.data.prompt.trim()));
  if (!target) return { changed: false, reason: 'no "# OVERALL GOAL" node found', workflow: wf };
  if (target.data.prompt.includes(PROMPT_MARKER)) return { changed: false, reason: 'already applied', workflow: wf };
  target.data.prompt = target.data.prompt.replace(/\s+$/, '') + '\n\n---\n\n' + PROMPT_SECTION + '\n';
  return { changed: true, workflow: wf };
}

function resolveLanguage(token) {
  if (!token) return null;
  const preset = LANGUAGE_PRESETS[String(token).toLowerCase()];
  return preset ? preset.code : String(token);
}

// ── db access helpers ─────────────────────────────────────────────────
async function readConfig() {
  const out = await psql(`SELECT jsonb_pretty(value::jsonb) FROM organization_configurations WHERE key='${CONFIG_KEY}' LIMIT 1;`);
  return JSON.parse(out);
}
async function readWorkflow() {
  const out = await psql('SELECT workflow_json::text FROM workflow_definitions WHERE id=(SELECT released_definition_id FROM workflows ORDER BY id LIMIT 1);');
  return JSON.parse(out);
}
async function writeConfig(cfg) {
  const tag = 'SS' + Math.random().toString(36).slice(2, 8);
  await psql(`UPDATE organization_configurations SET value = ${quoteJson(JSON.stringify(cfg), tag)}::json, updated_at = now() WHERE key='${CONFIG_KEY}';`);
}
async function writeWorkflow(wf) {
  const tag = 'SS' + Math.random().toString(36).slice(2, 8);
  await psql(`UPDATE workflow_definitions SET workflow_json = ${quoteJson(JSON.stringify(wf), tag)}::json WHERE id=(SELECT released_definition_id FROM workflows ORDER BY id LIMIT 1);`);
}
async function restartApi() {
  const r = await run('docker', ['restart', API_CONTAINER]);
  return r.code === 0;
}
function backup(state) {
  const prev = fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')) : {};
  fs.writeFileSync(BACKUP, JSON.stringify({ ...prev, ...state, at: new Date().toISOString() }, null, 2));
}

// ── commands ──────────────────────────────────────────────────────────
async function cmdShow() {
  const cfg = await readConfig();
  const wf = await readWorkflow();
  const d = cfg.dograh || {};
  console.log('Dograh agent — current tuning');
  console.log('  STT language : ' + (d.language || '(unset)') + (d.language === 'multi' ? '  → auto-detects: ' + MULTI_LANGUAGES.join(', ') : ''));
  console.log('  voice        : ' + (d.voice || '(unset)'));
  console.log('  speed        : ' + (d.speed != null ? d.speed : '(unset)'));
  const global = (wf.nodes || []).find((n) => n.data && /^#\s*OVERALL GOAL/i.test(String(n.data.prompt || '').trim()));
  console.log('  prompts      : ' + (global && global.data.prompt.includes(PROMPT_MARKER) ? 'India + international section applied' : 'stock (no India/international section)'));
  console.log('\nPresets: ' + Object.entries(LANGUAGE_PRESETS).map(([k, v]) => k + ' → ' + v.code).join(' · '));
}

async function cmdLanguage(token, apply) {
  const code = resolveLanguage(token);
  if (!code) { console.log('Usage: language india|international|multilingual|<code> [--apply]'); return 1; }
  const cfg = await readConfig();
  const before = (cfg.dograh || {}).language || '(unset)';
  if (before === code) { console.log('Already set to ' + code + ' — nothing to do.'); return 0; }
  const next = withLanguage(cfg, code);
  console.log('STT language: ' + before + ' → ' + code);
  if (code === 'multi') console.log('  (auto-detects: ' + MULTI_LANGUAGES.join(', ') + ')');
  if (code === 'en-IN') console.log('  (Deepgram Indian-English model — best for Indian accents and Hinglish)');
  if (!apply) { console.log('\nDry run — re-run with --apply to write it and restart the agent.'); return 0; }
  backup({ organizationConfig: cfg, at: new Date().toISOString() });
  await writeConfig(next);
  console.log('Written. Restarting ' + API_CONTAINER + ' so the agent reloads…');
  console.log((await restartApi()) ? '✔ Done — the free line is now on ' + code : '⚠ Write succeeded but the API restart failed');
  return 0;
}

async function cmdPrompts(apply) {
  const wf = await readWorkflow();
  const { changed, reason, workflow } = withIndiaPrompts(wf);
  if (!changed) { console.log('Prompts unchanged: ' + reason); return 0; }
  console.log('Prompts: add the "' + PROMPT_MARKER + '" section to the global prompt');
  console.log('  (Indian-English phrasing, Hindi/Hinglish matching, rupee/lakh handling, neutral tone for international callers)');
  if (!apply) { console.log('\nDry run — re-run with --apply to write it and restart the agent.'); return 0; }
  backup({ workflowJson: wf, at: new Date().toISOString() });
  await writeWorkflow(workflow);
  console.log('Written. Restarting ' + API_CONTAINER + ' so the agent reloads…');
  console.log((await restartApi()) ? '✔ Done — the agent now handles Indian and international callers.' : '⚠ Write succeeded but the API restart failed');
  return 0;
}

async function cmdRestore() {
  if (!fs.existsSync(BACKUP)) { console.log('No backup at ' + path.basename(BACKUP) + ' — nothing to restore.'); return 1; }
  const b = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  if (b.organizationConfig) { await writeConfig(b.organizationConfig); console.log('restored the voice brain config'); }
  if (b.workflowJson) { await writeWorkflow(b.workflowJson); console.log('restored the agent prompts'); }
  console.log((await restartApi()) ? '✔ Restored + restarted (' + b.at + ')' : '⚠ Restored, but the API restart failed');
  return 0;
}

module.exports = { withLanguage, withIndiaPrompts, resolveLanguage, LANGUAGE_PRESETS, MULTI_LANGUAGES, PROMPT_SECTION };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2).filter((a) => a !== '--apply');
    const apply = process.argv.includes('--apply');
    const [cmd, arg] = args;
    try {
      let code = 0;
      if (cmd === 'show') code = await cmdShow();
      else if (cmd === 'language') code = await cmdLanguage(arg, apply);
      else if (cmd === 'prompts') code = await cmdPrompts(apply);
      else if (cmd === 'restore') code = await cmdRestore();
      else {
        console.log('Usage: node scripts/dograh-tune.js show|language <preset> [--apply]|prompts [--apply]|restore');
        code = 1;
      }
      process.exit(code);
    } catch (e) {
      console.error('✗ ' + (e && e.message));
      process.exit(1);
    }
  })();
}
