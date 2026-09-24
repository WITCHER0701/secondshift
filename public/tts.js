/**
 * SecondShift — natural voice engine (Kokoro-82M, in-browser, free).
 *
 * Why not speechSynthesis? The default browser voices (Windows SAPI
 * David/Zira…) sound robotic and cheap. Kokoro-82M is an open-source
 * (Apache-2.0) neural TTS that runs 100% in the browser — no server,
 * no API key, still $0/mo — and sounds genuinely human.
 *
 * Architecture:
 *   - Synthesis runs inside a Web Worker (tts-worker.js) so the page UI
 *     never freezes while the model thinks (the old in-page version
 *     blocked the main thread mid-conversation).
 *   - While a chunk of speech is playing, the next chunk is already being
 *     generated in the worker → continuous, natural pacing, no dead air.
 *   - Text is normalized for the model ($ amounts, %, &, emoji) so it
 *     never reads symbols aloud like "dollar sign four five zero".
 *   - Falls back to the best system voice if the model can't load, so the
 *     agent NEVER goes silent. User can also force system mode (persisted).
 */
(function () {
  'use strict';

  // ── voices (real Kokoro voice packs) ─────────────────────────────────
  const VOICES = {
    af_heart:   { label: 'Heart · warm female (US)',      gender: 'f' },
    af_bella:   { label: 'Bella · expressive female (US)', gender: 'f' },
    am_michael: { label: 'Michael · calm male (US)',      gender: 'm' },
    am_adam:    { label: 'Adam · deep male (US)',         gender: 'm' },
    bf_emma:    { label: 'Emma · British female',         gender: 'f' },
  };
  const DEFAULT_VOICE = 'af_heart';

  const state = {
    ready: false,
    loading: false,
    failed: false,
    progress: 0,          // 0..1 model download
    speaking: false,
    mode: localStorage.getItem('ss_voice_mode') || 'kokoro',   // 'kokoro' | 'system'
    voice: localStorage.getItem('ss_voice_kokoro') || DEFAULT_VOICE,
    rate: parseFloat(localStorage.getItem('ss_voice_rate') || '1.0'),
  };

  const listeners = new Set();
  function notify() { listeners.forEach((fn) => { try { fn(state); } catch (_) {} }); }
  function onChange(fn) { listeners.add(fn); fn(state); }

  // ── text normalization — make written UI text sound natural ─────────
  const ONES = ['zero','one','two','three','four','five','six','seven','eight','nine','ten',
    'eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
  const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
  function numToWords(n) {
    if (!isFinite(n)) return String(n);
    n = Math.round(n);
    if (n < 0) return 'minus ' + numToWords(-n);
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
    if (n < 1000) return ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numToWords(n % 100) : '');
    if (n < 1000000) return numToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numToWords(n % 1000) : '');
    return String(n);
  }
  function normalizeForSpeech(text) {
    let t = String(text);
    t = t.replace(/[\u{1F000}-\u{1FAFF}\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}]/gu, ' '); // emoji
    t = t.replace(/&/g, ' and ');
    t = t.replace(/\$\s?([\d,]+(?:\.\d+)?)/g, (m, num) => {
      const v = parseFloat(num.replace(/,/g, ''));
      const words = numToWords(v);
      const cents = Math.round((v % 1) * 100);
      return ' ' + words + ' dollars' + (cents ? ' and ' + numToWords(cents) + ' cents' : '') + ' ';
    });
    t = t.replace(/([\d])\s?%/g, '$1 percent');
    t = t.replace(/\b(\d{1,2}):(\d{2})\s?([ap])\.?m\.?/gi, (m, h, mm, ap) => `${h} ${mm} ${ap.toLowerCase() === 'a' ? 'a m' : 'p m'}`);
    t = t.replace(/\b(\d{1,2})\s?([ap])\.?m\.?\b/gi, (m, h, ap) => `${h} ${ap.toLowerCase() === 'a' ? 'a m' : 'p m'}`);
    t = t.replace(/([a-z])\.([a-z])\./gi, '$1 $2'); // "p.m." leftovers → "p m"
    return t.replace(/\s+/g, ' ').trim();
  }

  // split long text on sentence boundaries so first audio starts fast
  function chunkText(text) {
    const clean = normalizeForSpeech(text);
    if (clean.length <= 220) return clean ? [clean] : [];
    const parts = clean.match(/[^.!?]+[.!?]*/g) || [clean];
    const chunks = [];
    let cur = '';
    for (const p of parts) {
      if ((cur + p).length > 220 && cur) { chunks.push(cur.trim()); cur = p; }
      else cur += p;
    }
    if (cur.trim()) chunks.push(cur.trim());
    return chunks;
  }

  // ── system-voice fallback (best available pick) ──────────────────────
  let sysVoices = [];
  function refreshSystemVoices() {
    if (!('speechSynthesis' in window)) return;
    sysVoices = speechSynthesis.getVoices();
  }
  if ('speechSynthesis' in window) {
    refreshSystemVoices();
    speechSynthesis.onvoiceschanged = refreshSystemVoices;
  }
  function bestSystemVoice() {
    if (!sysVoices.length) refreshSystemVoices();
    const prefer = [/natural/i, /neural/i, /google us english/i, /samantha/i, /aria/i, /jenny/i, /zira/i];
    const en = sysVoices.filter((v) => /^en/i.test(v.lang));
    for (const p of prefer) { const hit = en.find((v) => p.test(v.name)); if (hit) return hit; }
    return en[0] || sysVoices[0] || null;
  }
  function speakSystem(text, onend) {
    if (!('speechSynthesis' in window)) { onend && onend(); return; }
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(normalizeForSpeech(text));
      u.rate = 1.02 * (state.rate || 1);
      const v = bestSystemVoice();
      if (v) u.voice = v;
      u.onend = u.onerror = () => { state.speaking = false; notify(); onend && onend(); };
      state.speaking = true; notify();
      speechSynthesis.speak(u);
    } catch (e) { state.speaking = false; notify(); onend && onend(); }
  }

  // ── kokoro worker pipeline ───────────────────────────────────────────
  let worker = null;
  let reqId = 0;
  const pending = new Map(); // id -> resolve(blob | reject)

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker('/tts-worker.js');
    worker.onmessage = (e) => {
      const { id, type, blob, progress, message } = e.data || {};
      if (type === 'progress') { state.progress = Math.max(state.progress, progress); notify(); return; }
      if (type === 'ready') { state.ready = true; state.loading = false; notify(); return; }
      if (type === 'audio' && pending.has(id)) { pending.get(id).resolve(blob); pending.delete(id); return; }
      if (type === 'error') {
        if (id != null && pending.has(id)) { pending.get(id).reject(new Error(message)); pending.delete(id); }
        else { // init-level failure → permanent system fallback
          state.failed = true; state.loading = false; notify();
          console.warn('[voice] Kokoro unavailable, using system voice:', message);
        }
      }
    };
    worker.onerror = (e) => {
      state.failed = true; state.loading = false; notify();
      console.warn('[voice] worker error:', e && e.message);
    };
    state.loading = true; notify();
    worker.postMessage({ type: 'init' });
    return worker;
  }

  function generateChunk(chunk) {
    return new Promise((resolve, reject) => {
      const id = ++reqId;
      pending.set(id, { resolve, reject });
      ensureWorker().postMessage({ id, type: 'generate', text: chunk, voice: state.voice, speed: state.rate });
      setTimeout(() => {
        if (pending.has(id)) { pending.get(id).reject(new Error('generation timeout')); pending.delete(id); }
      }, 120000);
    });
  }

  function playAudio(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.className = 'ss-tts';
      a.onended = a.onerror = () => { URL.revokeObjectURL(url); a.remove(); resolve(); };
      a.play().catch(() => { URL.revokeObjectURL(url); resolve(); });
    });
  }

  // sequential playback with one-chunk lookahead generation
  let utterance = 0;
  async function speak(text) {
    if (!text) return;
    const myToken = ++utterance;
    stopPlayback(false);
    if (state.mode === 'system' || state.failed) { speakSystem(text); return; }

    const chunks = chunkText(text);
    if (!chunks.length) return;
    state.speaking = true; notify();
    try {
      ensureWorker();
      let nextAudio = null;
      for (let i = 0; i < chunks.length; i++) {
        if (myToken !== utterance) return; // superseded by a newer speak()
        // prefetch: generate chunk i (or reuse lookahead), request i+1 while playing
        const audio = nextAudio || await generateChunk(chunks[i]);
        if (myToken !== utterance) return;
        nextAudio = (i + 1 < chunks.length) ? generateChunk(chunks[i + 1]) : null;
        await playAudio(audio);
      }
    } catch (e) {
      console.warn('[voice] kokoro generation failed, falling back:', e && e.message);
      if (myToken === utterance) speakSystem(text);
    } finally {
      if (myToken === utterance) { state.speaking = false; notify(); }
    }
  }

  function stopPlayback(cancelFlag = true) {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    document.querySelectorAll('audio.ss-tts').forEach((a) => { try { a.pause(); a.remove(); } catch (_) {} });
    if (cancelFlag) { state.speaking = false; notify(); }
  }
  function stopSpeaking() { utterance++; stopPlayback(true); }

  // ── settings API for UI ──────────────────────────────────────────────
  function setMode(m) { state.mode = m; localStorage.setItem('ss_voice_mode', m); notify(); }
  function setVoice(v) { state.voice = v; localStorage.setItem('ss_voice_kokoro', v); }
  function setRate(r) { state.rate = Math.min(1.3, Math.max(0.8, +r || 1)); localStorage.setItem('ss_voice_rate', state.rate); }

  window.SecondShiftVoice = { speak, stop: stopSpeaking, onChange, setMode, setVoice, setRate, VOICES, state };
})();
