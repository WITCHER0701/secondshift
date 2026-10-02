#!/usr/bin/env node
/**
 * Voice defaults unit test — no browser, no network.
 *
 * The in-browser voice model is OPT-IN: a visitor who never touches the
 * "Natural voice" switch must not download anything. This test loads
 * public/tts.js in a stubbed browser and checks that contract, that voice
 * labels stay persona-only (no engine names), and that nothing Indian-market
 * specific is baked into the browser voice path (that tuning lives on the
 * Dograh free line — see scripts/dograh-tune.js).
 *
 * Run: node scripts/test-voice-defaults.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let ok = true;
const t = (pass, label, extra) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label + (extra ? ' — ' + extra : '')); if (!pass) ok = false; };

const TTS_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'tts.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'voice.html'), 'utf8');

function loadTTS({ stored = {} } = {}) {
  const store = { ...stored };
  const sandbox = {
    navigator: { language: 'en-US' },
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {}, toggle() {} } }),
    },
    speechSynthesis: { getVoices: () => [], speak() {}, cancel() {} },
    SpeechSynthesisUtterance: function (text) { this.text = text; },
    Worker: function () { this.postMessage = () => {}; },
    Audio: function () { this.play = () => Promise.resolve(); this.pause = () => {}; this.remove = () => {}; },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    console, setTimeout, clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(TTS_SRC, sandbox, { filename: 'tts.js' });
  return { api: sandbox.SecondShiftVoice, store };
}

// ── 1 — opt-in: nothing auto-loads for a fresh visitor ─────────────────
const fresh = loadTTS();
t(fresh.api.state.mode === 'system', 'fresh visitor → neural model OFF by default', 'mode=' + fresh.api.state.mode);
t(typeof fresh.api.warm === 'function', 'warm() exists for explicit opt-in');
t(fresh.api.state.voice === 'af_heart', 'default voice is the stock one', fresh.api.state.voice);

// ── 2 — a returning visitor's explicit choice is respected ─────────────
const returning = loadTTS({ stored: { ss_voice_mode: 'kokoro', ss_voice_kokoro: 'am_adam' } });
t(returning.api.state.mode === 'kokoro' && returning.api.state.voice === 'am_adam', 'saved visitor settings respected',
  returning.api.state.mode + '/' + returning.api.state.voice);
const bad = loadTTS({ stored: { ss_voice_kokoro: 'not_a_voice' } });
t(bad.api.state.voice === 'af_heart', 'unknown saved voice falls back safely', bad.api.state.voice);

// ── 3 — labels stay persona-only (no engine names on the page) ─────────
const labels = Object.values(fresh.api.VOICES).map((v) => v.label).join(' | ');
t(!/kokoro|vapi/i.test(labels), 'voice labels never name the engine', labels.slice(0, 80));
t(Object.keys(fresh.api.VOICES).length === 5, 'the stock five voices are back (no market-specific additions)');

// ── 4 — the page wires the opt-in, and nothing India-specific remains ──
t(!/id="vbNatural"[^>]*checked/.test(HTML), 'page does not pre-check “Natural voice”');
t(/TTS\.warm\(\)/.test(HTML), 'checking the box warms the model on demand');
t(!/vbRegion/.test(HTML), 'no accent picker on the browser demo page');
t(!/TTS\.setRegion|TTS\.lang\(\)/.test(HTML), 'no region wiring left in the page');
t(/recog\.lang = 'en-US'/.test(HTML) && !/TTS\.lang\(\)/.test(HTML), 'browser recognition stays plain en-US');

// ── 5 — engine: no India-only helpers left in tts.js ───────────────────
t(!/REGIONS|setRegion|hf_alpha|rupees|lakh/.test(TTS_SRC), 'tts.js carries no market-specific voice/currency logic');

// ── 6 — the booking brain still works exactly as before ───────────────
const voice = require(path.join(__dirname, '..', 'voice-agent.js'));
t(voice.parseWhen('Saturday at 11am').getHours() === 11, 'brain: plain time parsing intact');
const s = {
  id: 'call_test', state: 'confirm', slots: { service: 'haircut', when: new Date().toISOString(), name: 'Priya', phone: '5558675309' },
  tentative: null, transcript: [], intent: 'book', meta: {}, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
t(voice.advance(s, 'yes').done === true, 'brain: confirmation still completes a booking');

console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
