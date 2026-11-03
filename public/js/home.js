// Public website: loads non-secret config and wires the Telegram buttons.
(function () {
  'use strict';
  document.getElementById('year').textContent = new Date().getFullYear();

  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 })
    : null;
  document.querySelectorAll('.reveal').forEach((el, i) => {
    el.style.transitionDelay = `${Math.min(i % 6, 5) * 60}ms`;
    if (io) io.observe(el); else el.classList.add('in');
  });

  fetch('/api/public-config', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('config'))))
    .then((cfg) => {
      document.querySelectorAll('[data-price]').forEach((el) => { el.textContent = String(cfg.priceStars); });
      document.querySelectorAll('[data-days]').forEach((el) => { el.textContent = String(cfg.periodDays); });
      const bot = cfg.botUsername ? `https://t.me/${encodeURIComponent(cfg.botUsername)}` : null;
      document.querySelectorAll('[data-subscribe]').forEach((a) => { if (bot) { a.href = `${bot}?start=subscribe`; a.target = '_blank'; a.rel = 'noopener'; } });
      document.querySelectorAll('[data-bot-link]').forEach((a) => { if (bot) { a.href = bot; a.target = '_blank'; a.rel = 'noopener'; } });
      const join = cfg.groupInviteLink || bot;
      document.querySelectorAll('[data-join]').forEach((a) => { if (join) { a.href = join; a.target = '_blank'; a.rel = 'noopener'; } });
    })
    .catch(() => { /* static fallback: buttons stay as anchors */ });
})();
