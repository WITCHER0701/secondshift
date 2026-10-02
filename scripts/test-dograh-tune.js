#!/usr/bin/env node
/**
 * dograh-tune unit test — offline: no docker, no database.
 *
 * Guards the two edits the tuner makes on the live free line:
 *   - language preset merge into MODEL_CONFIGURATION_V2 (api_key preserved)
 *   - India + international behaviour section appended to the global prompt
 *
 * Run: node scripts/test-dograh-tune.js
 */
const path = require('path');

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };

const tune = require(path.join(__dirname, 'dograh-tune.js'));

// ── presets ────────────────────────────────────────────────────────────
t(tune.LANGUAGE_PRESETS.india.code === 'en-IN', 'india preset → en-IN (Indian English model)');
t(tune.LANGUAGE_PRESETS.international.code === 'en', 'international preset → accent-agnostic English');
t(tune.LANGUAGE_PRESETS.multilingual.code === 'multi', 'multilingual preset → multi auto-detect');
t(tune.MULTI_LANGUAGES.includes('hi') && tune.MULTI_LANGUAGES.includes('en'), 'multi really covers Hindi + English', tune.MULTI_LANGUAGES.join(','));
t(tune.resolveLanguage('india') === 'en-IN' && tune.resolveLanguage('en-IN') === 'en-IN', 'preset names and raw codes both resolve');
t(tune.resolveLanguage('') === null, 'empty token resolves to null');

// ── language merge keeps everything else, including the api_key ────────
const live = { mode: 'dograh', dograh: { speed: 1.0, voice: 'default', api_key: 'secret-key', language: 'multi' }, version: 2 };
const merged = tune.withLanguage(live, 'en-IN');
t(merged.dograh.language === 'en-IN', 'language switched to en-IN');
t(merged.dograh.api_key === 'secret-key', 'managed api_key preserved');
t(merged.dograh.voice === 'default' && merged.dograh.speed === 1.0, 'voice + speed untouched');
t(merged.mode === 'dograh' && merged.version === 2, 'mode + version untouched');
t(tune.withLanguage({}, 'en').dograh.language === 'en', 'missing dograh block is created safely');
t(live.dograh.language === 'multi', 'merge does not mutate the original object');

// ── prompt patch ───────────────────────────────────────────────────────
const wf = {
  nodes: [
    { id: 'start', data: { prompt: 'You have received an inbound call. Greet the user.' } },
    { id: 'global', data: { prompt: '# OVERALL GOAL\n\nYou are Sam. Keep responses short, 2-3 sentences.' } },
  ],
  edges: [],
};
const first = tune.withIndiaPrompts(wf);
t(first.changed === true, 'prompt patch applies to the global layer');
const patchedGlobal = first.workflow.nodes.find((n) => n.id === 'global').data.prompt;
const untouchedStart = first.workflow.nodes.find((n) => n.id === 'start').data.prompt;
t(patchedGlobal.includes('ACCENT & MARKET HANDLING'), 'section header added');
t(patchedGlobal.includes('You are Sam') && patchedGlobal.indexOf('You are Sam') < patchedGlobal.indexOf('ACCENT & MARKET'), 'original prompt kept, section appended');
t(untouchedStart === wf.nodes[0].data.prompt, 'other layers untouched');
t(wf.nodes[1].data.prompt.indexOf('ACCENT & MARKET') === -1, 'original workflow object not mutated');

// idempotent — running twice must not stack sections
const second = tune.withIndiaPrompts(first.workflow);
t(second.changed === false && /already applied/.test(second.reason), 'second run is a no-op', second.reason);
const missing = tune.withIndiaPrompts({ nodes: [{ id: 'x', data: { prompt: 'hello' } }] });
t(missing.changed === false && /no "# OVERALL GOAL"/.test(missing.reason), 'missing global node fails safe', missing.reason);

// ── the section actually covers the Indian-market behaviours ───────────
const section = tune.PROMPT_SECTION;
t(/kindly/.test(section) && /day after tomorrow/.test(section) && /o'clock/.test(section), 'Indian-English phrasing is named');
t(/Hindi|Hinglish/i.test(section), 'Hindi/Hinglish replies instructed');
t(/\+91/.test(section) && /lakh/.test(section) && /crore/.test(section), 'Indian numbers + lakh/crore covered');
t(/neutral English tone/.test(section), 'international callers keep a neutral tone');
t(/10-25 words/.test(section), 'short-reply rule kept');

console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
