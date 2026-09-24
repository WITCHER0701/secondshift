/* ═══════════════════════════════════════════════════════════════
   SecondShift — scroll experience engine
   Inertia wheel scrolling · progress bar · layered parallax ·
   reveal orchestration · counters · pinned scrollytelling ·
   3D tilt · marquee · nav behavior · to-top
   Zero dependencies. Respects prefers-reduced-motion.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE_POINTER = window.matchMedia('(pointer: fine)').matches;
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  /* ── 1 · Scroll progress bar ─────────────────────────────── */
  const progress = document.createElement('div');
  progress.className = 'scroll-progress';
  document.body.appendChild(progress);
  let shownProgress = 0;

  /* ── 2 · Inertia wheel scrolling (desktop, fine pointers) ── */
  // Native scroll stays the source of truth; wheel input is eased
  // so motion glides instead of stepping. Touch/trackpads untouched.
  let targetY = null;
  let animating = false;

  function inertialLoop() {
    if (targetY === null) { animating = false; return; }
    const current = window.scrollY;
    // distance-adaptive: big flicks glide a touch longer, small ticks land almost instantly
    const dist = Math.abs(targetY - current);
    const ease = dist > 800 ? 0.28 : dist > 250 ? 0.42 : 0.65;
    const next = lerp(current, targetY, ease);
    if (Math.abs(targetY - next) < 1.5) {
      window.scrollTo(0, targetY);
      targetY = null;
      animating = false;
      return;
    }
    window.scrollTo(0, next);
    requestAnimationFrame(inertialLoop);
  }
  function kick() {
    if (!animating) { animating = true; requestAnimationFrame(inertialLoop); }
  }

  if (!REDUCED && FINE_POINTER) {
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey) return; // pinch-zoom
      // let nested scrollables (chat log, tables) scroll natively
      const t = e.target;
      if (t && t.closest && t.closest('.screen-body, .table-wrap, textarea, .msg-list, .feed')) return;
      e.preventDefault();
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (targetY === null) targetY = window.scrollY;
      // strict 1:1 with the wheel — no artificial slowdown, just eased landing
      targetY = clamp(targetY + e.deltaY, 0, max);
      kick();
    }, { passive: false });
    // keyboard/anchor jumps resync the target
    window.addEventListener('keydown', (e) => {
      if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(e.key)) targetY = null;
    });
  }

  /* ── 3 · Unified scroll state ────────────────────────────── */
  const nav = document.querySelector('.nav');
  const toTop = document.createElement('button');
  toTop.className = 'to-top';
  toTop.setAttribute('aria-label', 'Back to top');
  toTop.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.body.appendChild(toTop);
  toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' }));

  // parallax elements: [data-parallax] viewport-relative · [data-hero-speed] scroll-linked
  const pxEls = [];
  const heroLayers = [];
  let hero = null, heroContent = null, scrolly = null, scrollyFill = null, scrollySteps = [];

  function collect() {
    pxEls.length = 0; heroLayers.length = 0;
    document.querySelectorAll('[data-parallax]').forEach((el) =>
      pxEls.push({ el, speed: parseFloat(el.getAttribute('data-parallax')) || 0.2 }));
    document.querySelectorAll('[data-hero-speed]').forEach((el) =>
      heroLayers.push({ el, speed: parseFloat(el.getAttribute('data-hero-speed')) || 0.2 }));
    hero = document.querySelector('.hero');
    heroContent = hero ? hero.querySelector('.hero-content') : null;
    scrolly = document.querySelector('.scrolly');
    scrollyFill = document.querySelector('.scrolly-rail-fill');
    scrollySteps = [...document.querySelectorAll('.scrolly-step')];
  }
  collect();
  window.addEventListener('load', collect); // after images/layout settle
  // re-collect when cards are injected dynamically
  const grid = document.getElementById('featuredGrid') || document.getElementById('catalogGrid');
  if (grid) {
    const mo = new MutationObserver(() => collect());
    mo.observe(grid, { childList: true });
  }

  let lastY = window.scrollY;
  function onScrollFrame() {
    const y = window.scrollY;
    const vh = window.innerHeight;
    const doc = document.documentElement.scrollHeight - vh;

    // progress bar
    const p = doc > 0 ? y / doc : 0;
    shownProgress = lerp(shownProgress, p, 0.2);
    progress.style.transform = 'scaleX(' + shownProgress.toFixed(4) + ')';

    // nav condense
    if (nav) nav.classList.toggle('scrolled', y > 24);
    toTop.classList.toggle('show', y > vh * 0.9);

    // layered parallax
    for (const { el, speed } of pxEls) {
      const r = el.getBoundingClientRect();
      const rel = r.top + r.height / 2 - vh / 2;
      el.style.transform = 'translate3d(0,' + (-rel * speed).toFixed(1) + 'px,0)';
    }

    // hero cinematic exit (fade + content drift + layers separate)
    if (hero && y < vh * 1.25) {
      heroLayers.forEach(({ el, speed }) => {
        el.style.transform = 'translate3d(0,' + (y * speed).toFixed(1) + 'px,0)';
      });
      if (heroContent) heroContent.style.transform = 'translate3d(0,' + (y * 0.4).toFixed(1) + 'px,0)';
      hero.style.opacity = y > 60 ? String(clamp(1 - (y - 60) / (vh * 0.8), 0, 1)) : '1';
    }
    lastY = y;
  }

  function scrollyFrame() {
    if (!scrolly) return;
    const r = scrolly.getBoundingClientRect();
    const total = r.height - window.innerHeight;
    if (total <= 0) return;
    const done = clamp(-r.top / total, 0, 1);
    if (scrollyFill) scrollyFill.style.transform = 'scaleY(' + done.toFixed(4) + ')';
    const activeIdx = Math.min(scrollySteps.length - 1, Math.floor(done * scrollySteps.length + 0.02));
    scrollySteps.forEach((s, i) => {
      const visual = s.querySelector('.scrolly-visual');
      if (i === activeIdx) {
        s.classList.add('on');
        if (visual) visual.classList.add('show');
      } else {
        s.classList.remove('on');
        if (visual) visual.classList.remove('show');
      }
    });
  }

  let ticking = false;
  function frame() {
    ticking = false;
    onScrollFrame();
    scrollyFrame();
  }
  function requestFrame() {
    if (!ticking) { ticking = true; requestAnimationFrame(frame); }
  }
  window.addEventListener('scroll', requestFrame, { passive: true });
  window.addEventListener('resize', () => { collect(); requestFrame(); });
  frame();

  /* ── 4 · Reveal orchestration ────────────────────────────── */
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (!en.isIntersecting) return;
          const el = en.target;
          // [data-reveal-words]: split into spans, staggered rise
          if (el.hasAttribute('data-reveal-words')) {
            const text = el.textContent;
            el.setAttribute('aria-label', text);
            el.textContent = '';
            text.split(' ').forEach((w, i) => {
              const s = document.createElement('span');
              s.className = 'rv-word';
              s.textContent = w;
              s.style.transitionDelay = (i * 45) + 'ms';
              el.appendChild(s);
              el.appendChild(document.createTextNode(' '));
            });
            requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('words-in')));
          }
          el.classList.add('in');
          io.unobserve(el);
        });
      }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' })
    : null;

  document.querySelectorAll('.reveal, [data-reveal-words], .hr-draw').forEach((el) => {
    if (io) io.observe(el);
    else el.classList.add('in', 'words-in');
  });

  // pages injecting DOM after load (catalog cards, FAQ) can register elements:
  window.LabReveal = {
    observe(el) { if (io) io.observe(el); else el.classList.add('in', 'words-in'); },
    observeAll(root) { (root || document).querySelectorAll('.reveal:not(.in), [data-reveal-words]:not(.words-in)').forEach((el) => this.observe(el)); },
  };

  /* ── 5 · Counter animation ───────────────────────────────── */
  const fmtNum = (n, dec) => n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  function runCounter(el) {
    const target = parseFloat(el.getAttribute('data-count')) || 0;
    const suffix = el.getAttribute('data-suffix') || '';
    const dec = parseInt(el.getAttribute('data-decimals') || '0', 10);
    const t0 = performance.now(), dur = 1600;
    (function step(t) {
      const p = clamp((t - t0) / dur, 0, 1);
      el.textContent = fmtNum(target * (1 - Math.pow(1 - p, 3)), dec) + suffix;
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  const cio = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) { runCounter(en.target); cio.unobserve(en.target); }
        });
      }, { threshold: 0.5 })
    : null;
  document.querySelectorAll('[data-count]').forEach((el) => {
    if (cio) cio.observe(el); else runCounter(el);
  });

  /* ── 6 · 3D tilt cards (fine pointers only) ──────────────── */
  if (FINE_POINTER && !REDUCED) {
    document.querySelectorAll('.tilt').forEach((card) => {
      let raf = null;
      card.addEventListener('mousemove', (e) => {
        const r = card.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          card.style.setProperty('--rx', ((0.5 - py) * 6).toFixed(2) + 'deg');
          card.style.setProperty('--ry', ((px - 0.5) * 8).toFixed(2) + 'deg');
          card.style.setProperty('--mx', (px * 100).toFixed(1) + '%');
          card.style.setProperty('--my', (py * 100).toFixed(1) + '%');
        });
      });
      card.addEventListener('mouseleave', () => {
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
      });
    });
  }

  /* ── 7 · Marquee pause on hover is pure CSS. Nothing here. ─ */

  /* ── public helpers (kept for existing pages) ────────────── */
  window.LabUtil = {
    esc(s) {
      return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
    timeAgo(iso) {
      const s = (Date.now() - new Date(iso).getTime()) / 1000;
      if (s < 60) return 'just now';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    },
  };
})();
