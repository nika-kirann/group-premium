// Admin dashboard (vanilla JS). Auth is a httpOnly session cookie; no secrets live here.
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const H = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'group-premium' };

  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  function left(d) {
    const ms = new Date(d).getTime() - Date.now(); if (!d || ms <= 0) return '';
    const days = Math.floor(ms / 864e5); const h = Math.floor((ms % 864e5) / 36e5);
    return days ? `${days}d ${h}h left` : `${h}h left`;
  }
  function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3500); }

  async function api(path, opts = {}) {
    const res = await fetch(`/api/admin${path}`, { credentials: 'same-origin', headers: H, ...opts });
    if (res.status === 401) { showLogin(); throw new Error('Not authenticated'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function showLogin() { $('#app-view').hidden = true; $('#login-view').hidden = false; }
  function showApp() { $('#login-view').hidden = true; $('#app-view').hidden = false; }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target); const btn = e.target.querySelector('button'); btn.disabled = true; $('#login-error').textContent = '';
    try {
      const res = await fetch('/api/admin/login', { method: 'POST', credentials: 'same-origin', headers: H, body: JSON.stringify({ telegramId: f.get('telegramId'), password: f.get('password') }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login failed');
      e.target.reset(); await start();
    } catch (err) { $('#login-error').textContent = err.message; } finally { btn.disabled = false; }
  });

  $('#btn-logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
  $('#btn-sync').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try { const r = await api('/maintenance', { method: 'POST' }); toast(r.skipped ? 'Sync already running' : `Sync done: ${r.expired} expired, ${r.retriedGrants} grants retried`); await loadAll(); } catch (err) { toast(err.message); } finally { e.target.disabled = false; }
  });

  const li = (label, ok, value) => `<li><span><span class="dot ${ok === null ? 'warn' : ok ? 'ok' : 'bad'}"></span>${esc(label)}</span><span>${esc(value)}</span></li>`;

  async function loadOverview() {
    const o = await api('/overview');
    const s = o.stats;
    $('#s-members').textContent = s.groupMembers ?? 'n/a';
    $('#s-active').textContent = s.active; $('#s-expired').textContent = s.expired;
    $('#s-payments').textContent = s.payments; $('#s-stars').textContent = s.stars; $('#s-renew').textContent = s.auto_renew;
    const g = o.group;
    $('#group-status').innerHTML = [
      li('Group', !!g.title, g.title || 'unreachable'),
      li('Type is supergroup', g.type === 'supergroup', g.type || '—'),
      li('Bot is administrator', g.botStatus === 'administrator', g.botStatus || '—'),
      li('Restrict members', !!g.rights?.can_restrict_members, g.rights?.can_restrict_members ? 'granted' : 'missing'),
      li('Manage member tags', !!g.rights?.can_manage_tags, g.rights?.can_manage_tags ? 'granted' : 'missing'),
      li('Default permissions (/setup)', g.setup ? true : null, g.setup ? `applied ${fmt(g.setup.at)}` : 'not applied yet'),
      li('Photo mode', true, g.photoMode),
      g.error ? li('Problem', false, g.error) : '',
    ].join('');
    const b = o.bot; const m = o.maintenance;
    $('#bot-status').innerHTML = [
      li('Bot', !!b.username, b.username ? `@${b.username}` : 'not initialised'),
      li('Bot API reachable', b.connected, b.connected ? 'yes' : 'no'),
      li('Webhook', b.webhookOk, b.webhookOk ? 'configured' : 'not pointing to this server'),
      li('Pending updates', (b.pendingUpdates ?? 0) < 50, b.pendingUpdates ?? '—'),
      li('Last webhook error', !b.lastError, b.lastError ? `${b.lastError} (${fmt(b.lastErrorAt)})` : 'none'),
      li('Last expiry sync', m ? true : null, m ? fmt(m.at) : 'never'),
      li('Plan', true, `${o.plan.price} ⭐ / ${Math.round(o.plan.period / 86400)} days`),
    ].join('');
  }

  function chip(sub) {
    if (!sub.status) return '<span class="chip FREE">FREE</span>';
    return `<span class="chip ${esc(sub.status)}">${esc(sub.status)}</span>`;
  }

  async function loadSubscribers() {
    const q = encodeURIComponent($('#q').value.trim()); const st = encodeURIComponent($('#status-filter').value);
    const { subscribers } = await api(`/subscribers?q=${q}&status=${st}`);
    $('#subs-body').innerHTML = subscribers.length ? subscribers.map((u) => `
      <tr>
        <td><strong>${esc(u.first_name || '—')}</strong>${u.username ? `<br><span class="muted small">@${esc(u.username)}</span>` : ''}</td>
        <td class="mono">${esc(u.telegram_id)}</td>
        <td>${chip(u)}</td>
        <td>${fmt(u.expires_at)}${u.status === 'ACTIVE' ? `<br><span class="muted small">${left(u.expires_at)}</span>` : ''}</td>
        <td>${u.status === 'ACTIVE' ? (u.source === 'manual' ? 'manual' : u.auto_renew ? '🔁 on' : '⏹ off') : '—'}</td>
        <td>${u.status ? (u.last_sync_error ? `<span class="chip REVOKED" title="${esc(u.last_sync_error)}">retrying</span>` : u.status === 'ACTIVE' ? (u.group_applied && u.tag_applied ? '✅' : '⏳') : '✅') : '—'}</td>
        <td><div class="row-actions">
          <button class="btn btn-ghost btn-sm" data-view="${esc(u.telegram_id)}">Details</button>
          ${u.status === 'ACTIVE' ? `<button class="btn btn-danger btn-sm" data-revoke="${esc(u.telegram_id)}">Revoke</button>` : `<button class="btn btn-primary btn-sm" data-grant="${esc(u.telegram_id)}">Grant</button>`}
        </div></td>
      </tr>`).join('') : '<tr><td colspan="7" class="muted">No users found.</td></tr>';
  }

  async function loadPayments() {
    const { payments } = await api('/payments?limit=25');
    $('#pay-body').innerHTML = payments.length ? payments.map((p) => `
      <tr>
        <td>${fmt(p.created_at)}</td>
        <td>${esc(p.first_name || '')} ${p.username ? `<span class="muted small">@${esc(p.username)}</span>` : ''}<br><span class="mono muted">${esc(p.telegram_id)}</span></td>
        <td><strong>${esc(p.total_amount)}</strong> ⭐</td>
        <td>${p.is_first_recurring ? 'New subscription' : p.is_recurring ? 'Renewal' : 'One-off'}</td>
        <td><span class="chip ${esc(p.status)}">${esc(p.status)}</span></td>
        <td><span class="mono trunc" title="${esc(p.telegram_payment_charge_id)}">${esc(p.telegram_payment_charge_id)}</span></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">No payments yet.</td></tr>';
  }

  async function showUser(id) {
    const d = await api(`/users/${encodeURIComponent(id)}`);
    const s = d.subscription; const m = d.member;
    $('#user-detail').innerHTML = `
      <h2>${esc(d.user.first_name || 'User')} ${d.user.username ? `<span class="muted small">@${esc(d.user.username)}</span>` : ''}</h2>
      <dl class="kv">
        <dt>Telegram ID</dt><dd class="mono">${esc(d.user.telegram_id)}</dd>
        <dt>Status</dt><dd>${s ? chip(s) : chip({})}</dd>
        <dt>Source</dt><dd>${esc(s?.source || '—')}</dd>
        <dt>Started</dt><dd>${fmt(s?.started_at)}</dd>
        <dt>Expires</dt><dd>${fmt(s?.expires_at)} ${s?.status === 'ACTIVE' ? `<span class="muted small">(${left(s.expires_at)})</span>` : ''}</dd>
        <dt>Auto-renewal</dt><dd>${s?.auto_renew ? 'On' : 'Off'}${s?.canceled_at ? ` (cancelled ${fmt(s.canceled_at)})` : ''}</dd>
        <dt>Charge ID</dt><dd class="mono">${esc(s?.last_charge_id || '—')}</dd>
        <dt>In group</dt><dd>${m ? `${esc(m.status)}${m.tag ? ` · tag “${esc(m.tag)}”` : ''}${m.can_send_photos != null ? ` · photos ${m.can_send_photos ? 'on' : 'off'}` : ''}` : 'not a member / unknown'}</dd>
        <dt>Sync error</dt><dd>${esc(s?.last_sync_error || 'none')}</dd>
        <dt>First seen</dt><dd>${fmt(d.user.created_at)}</dd>
      </dl>
      <h3>Payments</h3>
      <div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Amount</th><th>Type</th><th>Status</th></tr></thead><tbody>
      ${d.payments.length ? d.payments.map((p) => `<tr><td>${fmt(p.created_at)}</td><td>${esc(p.total_amount)} ⭐</td><td>${p.is_first_recurring ? 'New' : p.is_recurring ? 'Renewal' : 'One-off'}</td><td><span class="chip ${esc(p.status)}">${esc(p.status)}</span></td></tr>`).join('') : '<tr><td colspan="4" class="muted">None</td></tr>'}
      </tbody></table></div>`;
    $('#user-dialog').showModal();
  }

  async function grant(id, days) {
    if (!/^\d{1,20}$/.test(String(id))) return toast('Invalid Telegram ID');
    if (!confirm(`Grant premium to ${id} for ${days} day(s)?`)) return;
    try {
      const r = await api(`/users/${id}/grant`, { method: 'POST', body: JSON.stringify({ days: Number(days) }) });
      toast(r.group.applied ? 'Premium granted and applied in the group' : `Granted. Group: ${r.group.reason || 'pending'}`);
      await loadAll();
    } catch (e) { toast(e.message); }
  }
  async function revoke(id) {
    if (!confirm(`Revoke premium for ${id} now? Photo permission and PREMIUM tag will be removed and auto-renewal cancelled.`)) return;
    try { const r = await api(`/users/${id}/revoke`, { method: 'POST', body: '{}' }); toast(r.group.applied ? 'Premium revoked' : `Revoked in DB; group: ${r.group.reason}`); await loadAll(); } catch (e) { toast(e.message); }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.view) showUser(t.dataset.view).catch((err) => toast(err.message));
    if (t.dataset.revoke) revoke(t.dataset.revoke);
    if (t.dataset.grant) grant(t.dataset.grant, 30);
  });
  $('#grant-form').addEventListener('submit', (e) => { e.preventDefault(); const f = new FormData(e.target); grant(String(f.get('userId')).trim(), f.get('days')); });
  $('#search-form').addEventListener('submit', (e) => { e.preventDefault(); loadSubscribers().catch((err) => toast(err.message)); });
  $('#status-filter').addEventListener('change', () => loadSubscribers().catch((err) => toast(err.message)));

  async function loadAll() { await Promise.all([loadOverview(), loadSubscribers(), loadPayments()]); }

  async function start() {
    try {
      const me = await api('/me'); showApp();
      await loadAll();
      $('#whoami').textContent = `ID ${me.telegramId}`;
    } catch (e) { if (e.message !== 'Not authenticated') toast(e.message); }
  }
  start();
  setInterval(() => { if (!$('#app-view').hidden && document.visibilityState === 'visible') loadAll().catch(() => {}); }, 60000);
})();
