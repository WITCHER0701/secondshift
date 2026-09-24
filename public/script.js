/* Legacy stub — all scroll/UI behavior now lives in scroll.js.
   Kept only so any cached page referencing /script.js still gets LabUtil. */
(function () {
  if (!window.LabUtil) {
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
  }
})();
