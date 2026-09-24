/*
 * SecondShift — Kokoro TTS Web Worker.
 * Loads the Kokoro-82M neural model (Apache-2.0, ~86MB q8) off the main
 * thread so generating speech never blocks or freezes the page. Each
 * request returns a WAV Blob; the main thread just plays them in order.
 *
 * Messages in:  { id, type: 'init' | 'generate', text, voice, speed }
 * Messages out: { id, type: 'ready' }
 *               { id, type: 'audio', blob }
 *               { id, type: 'progress', progress }   (0..1, model download)
 *               { id, type: 'error', message }
 */
'use strict';

const CDN = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DTYPE = 'q8';

let tts = null;
let loading = null; // shared init promise

async function ensureModel() {
  if (tts) return tts;
  if (loading) return loading;
  loading = (async () => {
    const mod = await import(CDN);
    tts = await mod.KokoroTTS.from_pretrained(MODEL_ID, {
      dtype: DTYPE,
      progress_callback: (p) => {
        if (p && p.status === 'progress' && p.progress != null) {
          self.postMessage({ type: 'progress', progress: p.progress / 100 });
        }
      },
    });
    self.postMessage({ type: 'ready' });
    return tts;
  })();
  return loading;
}

self.onmessage = async (e) => {
  const { id, type, text, voice, speed } = e.data || {};
  try {
    if (type === 'init') { await ensureModel(); return; }
    if (type === 'generate') {
      const model = await ensureModel();
      const audio = await model.generate(text, { voice: voice || 'af_heart', speed: speed || 1.0 });
      const blob = typeof audio.toBlob === 'function' ? audio.toBlob() : audio;
      self.postMessage({ id, type: 'audio', blob });
      return;
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err && err.message) || String(err) });
  }
};
