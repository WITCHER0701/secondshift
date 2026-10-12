/**
 * ss-chrome.js — SecondShift site chrome unifier.
 *
 * The homepage (/, React) has the new header/footer; the legacy pages
 * (test-drive, deal, automations, process, rishi, …) still use the old
 * styles.css look. This script re-skins the elements those pages ALREADY
 * have (`nav.nav`, `footer.footer`) with the homepage's visual language —
 * same colors (#10141D / #0A0C10), same logo-strip wordmark, the pulsing
 * "Shift: CLOCKED IN" chip, and the gradient "Make a Deal" pill — WITHOUT
 * touching the pages' content markup. Idempotent and hairline-agnostic:
 * if a page lacks the assumed element, it just does nothing for that part.
 *
 * Usage: <script src="/ss-chrome.js" defer></script> before </body>.
 */
(function () {
  'use strict';
  if (window.__SS_CHROME__) return;
  window.__SS_CHROME__ = true;

  // ── styles (mirrors the homepage header/footer classes) ──────────────
  var css = [
    // header shell — the homepage look
    '.nav{background:rgba(16,20,29,.88)!important;-webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);border-bottom:1px solid rgba(255,255,255,.07)!important;box-shadow:0 1px 8px rgba(0,0,0,.5)!important}',
    '.nav.scrolled{background:rgba(16,20,29,.94)!important}',
    '.nav-inner{max-width:1240px!important;padding:0 24px!important;gap:16px}',
    // logo strip
    '.nav-logo img{height:30px!important;max-width:42vw;object-fit:contain;object-position:left;filter:drop-shadow(0 0 10px rgba(56,189,248,.35));transition:transform .25s}',
    '.nav-logo img:hover{transform:scale(1.04)}',
    // brand wordmark next to the strip (added below)
    '.ss-brand{display:flex;flex-direction:column;text-align:left;line-height:1}',
    '.ss-brand .ss-b1{font-family:var(--font-headline),"Space Grotesk",system-ui,sans-serif;font-size:19px;font-weight:700;color:#F8FAFC;letter-spacing:-.01em}',
    '.ss-brand .ss-b1 em{font-style:normal;color:#38bdf8}',
    '.ss-brand .ss-b2{font-family:ui-monospace,monospace;font-size:8.5px;color:#94A3B8;letter-spacing:.18em;text-transform:uppercase;margin-top:3px}',
    '.ss-clocked{display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:99px;background:#1E2433;border:1px solid rgba(255,255,255,.1);margin-left:auto;margin-right:8px}',
    '.ss-clocked .ss-dot{width:8px;height:8px;border-radius:50%;background:#10B981;box-shadow:0 0 8px rgba(16,185,129,.8);animation:ssPulse 1.8s ease-in-out infinite}',
    '.ss-clocked .ss-txt{font:600 10.5px/1 ui-monospace,monospace;color:#e2e2e8;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}',
    '@keyframes ssPulse{0%,100%{opacity:1}50%{opacity:.45}}',
    // nav links
    '.nav-links{gap:26px!important;align-items:center!important}',
    '.nav-links a{color:#bdc8d1!important;font-size:13.5px!important;font-weight:400!important;transition:color .2s}',
    '.nav-links a:hover{color:#fff!important}',
    '.nav-links a.nav-cta{background:linear-gradient(90deg,#38bdf8,#0053db)!important;color:#fff!important;padding:9px 18px!important;border-radius:99px!important;font-weight:600!important;font-size:13px!important;box-shadow:0 0 18px rgba(56,189,248,.35);transition:filter .2s,transform .2s}',
    '.nav-links a.nav-cta:hover{filter:brightness(1.12)!important;transform:translateY(-1px)}',
    '@media(max-width:860px){.ss-clocked{display:none}.ss-brand .ss-b2{display:none}.nav-links{gap:14px!important}.nav-links a{font-size:12.5px!important}.nav-inner{padding:0 14px!important}}',
    // footer — homepage accents
    '.footer{background:#10141D!important;border-top:1px solid rgba(255,255,255,.1)!important}',
    '.footer h5{color:#F8FAFC!important;font-size:11px!important;text-transform:uppercase;letter-spacing:.12em}',
    '.footer a{transition:color .2s}',
    '.footer a:hover{color:#8ed5ff!important}',
    '.footer .nav-logo img{height:26px!important;filter:drop-shadow(0 0 8px rgba(56,189,248,.3))}',
  ].join('\n');

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    var nav = document.querySelector('.nav');
    if (nav && !nav.querySelector('.ss-brand')) {
      // 1) wordmark beside the logo strip
      var logo = nav.querySelector('.nav-logo img');
      if (logo) {
        logo.setAttribute('src', '/logo-wide.png'); // crisp wide strip
        var brand = document.createElement('div');
        brand.className = 'ss-brand';
        brand.innerHTML = '<span class="ss-b1">Second<em>Shift</em></span><span class="ss-b2">Autonomous Studio</span>';
        logo.parentNode.appendChild(brand);
      }
      // 1b) gradient CTA pill — ensure every page carries one (home style)
      var links = nav.querySelector('.nav-links');
      if (links && !links.querySelector('.nav-cta') && !/deal\.html/.test(location.pathname)) {
        var cta = document.createElement('a');
        cta.href = '/deal.html';
        cta.className = 'nav-cta';
        cta.textContent = 'Make a Deal';
        links.appendChild(cta);
      }

    // 2) "Clocked in" chip parked right after the logo group
      var inner = nav.querySelector('.nav-inner');
      if (inner && !inner.querySelector('.ss-clocked')) {
        var chip = document.createElement('div');
        chip.className = 'ss-clocked';
        chip.title = 'The site keeps working while you sleep';
        chip.innerHTML = '<span class="ss-dot"></span><span class="ss-txt">Shift: Clocked in</span>';
        inner.insertBefore(chip, inner.querySelector('.nav-links'));
      }
    }

    // footer: swap strip for web logo handled by CSS above; nothing else needed.
  });
})();
