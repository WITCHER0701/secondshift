/**
 * ss-strobi.js — Strobi, the SecondShift on-screen bot, for any page.
 *
 * Procedural 2D avatar from smontlouis/bible-strong-avatar-lab
 * (https://github.com/smontlouis/bible-strong-avatar-lab — AGPL-3.0-only),
 * rendered by the lab's official @bible-strong/avatar-web renderer bundled
 * standalone into /bot/avatar-standalone.js. Attribution bubble + source
 * link included (AGPL requirement), consistent with the main site widget.
 *
 * Usage (voice.html):
 *   <script src="/ss-strobi.js" data-voice="1"></script>
 * With data-voice="1", the bot reacts to the page's voice state:
 *   thinking  → 'thinking'   ( setStatus('The Voice is thinking…') )
 *   listening → 'listening'  ( mic/line open )
 *   speaking  → 'happy'      ( agent TTS speaking )
 *   booked/ended → 'celebrate' / 'sleeping'
 * It reads those states by hooking the page globals (setStatus, TTS, the
 * end-note slot pills) instead of duplicating logic.
 *
 * Skins: reads the same ss-bot-skin localStorage as the React widget;
 * long-press / right-click on the bot opens the character picker.
 */
(function () {
  'use strict';
  if (window.__SS_STROBI__) return;
  window.__SS_STROBI__ = true;

  var CHARACTERS = {
    strobi:      { label: 'Strobi',   file: '/bot/strobi.avatar.json',      body: '#5b7fe5', eye: '#111316' },
    secondshift: { label: 'Midnight', file: '/bot/secondshift.avatar.json', body: '#0e1420', eye: '#38bdf8' },
    oni:         { label: 'Oni',      file: '/bot/oni.avatar.json',         body: '#1d1f2b', eye: '#f97316' },
    mint:        { label: 'Mint',     file: '/bot/mint.avatar.json',        body: '#10b981', eye: '#052e16' },
    ember:       { label: 'Ember',    file: '/bot/ember.avatar.json',       body: '#ef4444', eye: '#111316' },
  };
  var skinId = 'secondshift';
  try { if (CHARACTERS[localStorage.getItem('ss-bot-skin')]) skinId = localStorage.getItem('ss-bot-skin'); } catch (e) {}

  var isVoicePage = !!(document.currentScript && document.currentScript.getAttribute('data-voice'));
  var isPhone = /iPhone|Android|webOS|BlackBerry|Opera Mini|IEMobile/i.test(navigator.userAgent);
  var sizePx = isPhone ? 64 : 84;

  // ── shell ───────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '.ss-strobi{position:fixed;right:14px;bottom:14px;z-index:2147483000;touch-action:manipulation}',
    '.ss-strobi-btn{width:' + sizePx + 'px;height:' + sizePx + 'px;border-radius:26px;overflow:hidden;display:block;cursor:pointer;background:#10141D/90;border:1px solid rgba(56,189,248,.3);box-shadow:0 10px 36px rgba(56,189,248,.25);transition:transform .15s, box-shadow .15s;padding:0}',
    '.ss-strobi-btn:hover{transform:scale(1.06);box-shadow:0 10px 44px rgba(56,189,248,.45)}',
    '.ss-strobi-host{width:100%;height:100%}',
    '.ss-strobi-card{position:fixed;right:14px;bottom:' + (sizePx + 22) + 'px;width:248px;background:#161B26;border:1px solid rgba(56,189,248,.3);border-radius:16px;padding:14px;color:#e2e2e8;font:12px/1.55 Inter,system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.55);z-index:2147483000}',
    '.ss-strobi-card b{color:#8ed5ff;font-weight:600}',
    '.ss-strobi-card a{color:#38bdf8;text-decoration:underline}',
    '.ss-strobi-skins{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}',
    '.ss-strobi-skin{width:30px;height:30px;border-radius:50%;border:2px solid transparent;cursor:pointer;position:relative;padding:0}',
    '.ss-strobi-skin.on{border-color:#38bdf8}',
    '.ss-strobi-skin span{position:absolute;top:6px;left:18px;width:6px;height:6px;border-radius:50%}',
    '@media(max-width:640px){.ss-strobi-card{width:220px;right:10px;bottom:' + (sizePx + 16) + 'px}}',
  ].join('\n');
  document.head.appendChild(style);

  var wrap = document.createElement('div');
  wrap.className = 'ss-strobi';
  var btn = document.createElement('button');
  btn.className = 'ss-strobi-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Toggle Strobi the SecondShift bot');
  btn.title = 'Strobi (Midnight) — SecondShift on-screen bot';
  var host = document.createElement('div');
  host.className = 'ss-strobi-host';
  btn.appendChild(host);
  var card = null;
  wrap.appendChild(btn);
  document.body.appendChild(wrap);

  // ── boot the renderer ───────────────────────────────────────────────
  var avatar = null;
  function play(anim) { try { avatar && avatar.play(anim); } catch (e) {} }
  window.SSStrobi = {
    play: play,
    setSkin: function (id) {
      if (!CHARACTERS[id]) return;
      skinId = id;
      try { localStorage.setItem('ss-bot-skin', id); } catch (e) {}
      location.reload(); // simplest reliable re-skin outside React
    },
    say: function (t) { openCard(t); },
  };

  var open = false;
  function openCard(msg) {
    if (card) { card.remove(); card = null; }
    open = true;
    card = document.createElement('div');
    card.className = 'ss-strobi-card';
    card.innerHTML = '<div>' + (msg || "<b>Strobi</b> — I'm the shift that never clocks out.") + '</div>';
    var skins = document.createElement('div');
    skins.className = 'ss-strobi-skins';
    Object.keys(CHARACTERS).forEach(function (id) {
      var c = CHARACTERS[id];
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ss-strobi-skin' + (id === skinId ? ' on' : '');
      b.title = c.label;
      b.style.background = c.body;
      b.innerHTML = '<span style="background:' + c.eye + '"></span>';
      b.addEventListener('click', function (ev) { ev.stopPropagation(); window.SSStrobi.setSkin(id); });
      skins.appendChild(b);
    });
    card.appendChild(skins);
    card.insertAdjacentHTML('beforeend',
      '<div style="margin-top:9px;font:9px/1.5 monospace;color:#64748B">' + CHARACTERS[skinId].label +
      ' · avatar by <a href="https://github.com/smontlouis/bible-strong-avatar-lab" target="_blank" rel="noopener">bible-strong-avatar-lab</a> (AGPL-3.0)</div>');
    wrap.appendChild(card);
  }
  function closeCard() { if (card) { card.remove(); card = null; } open = false; }
  document.addEventListener('click', function (ev) {
    if (card && !card.contains(ev.target) && !btn.contains(ev.target)) closeCard();
  });
  btn.addEventListener('click', function () {
    open = !open;
    if (open) openCard();
    else closeCard();
    play('happy');
  });

  function boot() {
    (Function("return import('/bot/avatar-standalone.js')")()).then(function (mod) {
      return fetch(CHARACTERS[skinId].file).then(function (r) { return r.json(); }).then(function (def) {
        avatar = mod.createAvatar(host, { definition: def, defaultAnimation: 'idle', size: '100%' });
        play(isVoicePage ? 'idle' : 'working');
      });
    }).catch(function (e) { console.error('Strobi failed to load', e); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // ── voice-page reactions (data-voice="1") ───────────────────────────
  if (isVoicePage) {
    var lineState = { speaking: false, listening: false };
    // 1) hook setStatus (global in voice.html's inline script)
    window.SSStrobi._origSetStatus = null;
    var applyVoiceState = function (phase) {
      if (phase === 'thinking') { play('thinking'); }
      else if (phase === 'listening') { play('listening'); }
      else if (phase === 'speaking') { play('happy'); }
      else if (phase === 'booked') { play('celebrate'); }
      else if (phase === 'ended') { play('sleeping'); }
      else if (phase === 'idle') { play('idle'); }
    };
    window.SSStrobi.voiceThis = applyVoiceState;

    // 2) TTS speaking → happy (the agent is talking to the visitor)
    //    voice.html: `const TTS = window.SecondShiftVoice` (tts.js) — same object.
    var tryTTS = 0;
    (function hookTTS() {
      var tts = window.SecondShiftVoice;
      if (tts && typeof tts.onChange === 'function') {
        tts.onChange(function (s) {
          if (s && s.speaking && !lineState.speaking) { lineState.speaking = true; applyVoiceState('speaking'); }
          else if (s && !s.speaking && lineState.speaking) { lineState.speaking = false; applyVoiceState(lineState.listening ? 'listening' : 'idle'); }
        });
      } else if (tryTTS++ < 40) setTimeout(hookTTS, 250);
    })();

    // 3) mic status polling: setStatus writes to #statusText and wires listening
    (function hookStatus() {
      var el = document.querySelector('#statusText');
      if (!el) { setTimeout(hookStatus, 300); return; }
      var last = '';
      setInterval(function () {
        var t = (el.textContent || '').toLowerCase();
        if (t === last) return;
        var before = last; last = t;
        if (/thinking/.test(t)) applyVoiceState('thinking');
        else if (/listening|line open|line live|mic to talk|speak now|just talk/.test(t)) { lineState.listening = true; applyVoiceState('listening'); }
        else if (/booked|celebrat/.test(t)) applyVoiceState('booked');
        else if (/ended|mic off|mic problem/.test(t)) { lineState.listening = false; applyVoiceState('ended'); }
        else if (!lineState.speaking) applyVoiceState('idle');
      }, 400);
    })();

    // 4) booking success (slot pills all filled + endnote) → celebrate once
    (function watchBooked() {
      var note = document.querySelector('#endNote');
      if (!note) { setTimeout(watchBooked, 300); return; }
      var offered = false;
      new MutationObserver(function () {
        var shown = note.classList.contains('show');
        if (shown && !offered) { offered = true; applyVoiceState('booked'); }
        else if (!shown) offered = false;
      }).observe(note, { attributes: true, attributeFilter: ['class'] });
    })();
  }
})();
