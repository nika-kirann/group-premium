// Protected admin API used by the dashboard.
import express from 'express';
import rateLimit from 'express-rate-limit';
import { login, logout, requireAdmin } from '../auth.js';
import { query, getSetting } from '../db.js';
import { config } from '../config.js';
import { bot, botInfoSafe } from '../botInstance.js';
import { inspectGroup } from '../permissions.js';
import { getStats, manualGrant, revokeSubscription, syncExpirations } from '../subscriptions.js';

export const adminRouter = express.Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts, try again later.' } });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

const userId = (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) { const e = new Error('Invalid Telegram user id'); e.status = 400; throw e; } return n; };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

adminRouter.post('/login', loginLimiter, wrap(async (req, res) => {
  if (req.get('x-requested-with') !== 'group-premium') return res.status(403).json({ error: 'CSRF check failed' });
  const r = await login(req, res, req.body?.telegramId, req.body?.password);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  return res.json({ ok: true });
}));

adminRouter.use(apiLimiter, requireAdmin);

adminRouter.post('/logout', wrap(async (req, res) => { await logout(req, res); res.json({ ok: true }); }));
adminRouter.get('/me', (req, res) => res.json({ telegramId: req.admin.telegramId }));

adminRouter.get('/overview', wrap(async (req, res) => {
  const [stats, group, webhook, lastMaint, setup] = await Promise.all([
    getStats(),
    inspectGroup(),
    bot.api.getWebhookInfo().catch((e) => ({ error: e.description || e.message })),
    getSetting('last_maintenance'),
    getSetting('group_setup'),
  ]);
  res.json({
    stats: { ...stats, groupMembers: group.memberCount },
    group: { ok: group.ok, title: group.title, type: group.chatType, botStatus: group.botStatus, rights: group.rights, error: group.error, setup, photoMode: config.photoMode },
    bot: {
      username: botInfoSafe()?.username ?? null,
      connected: !webhook.error,
      webhookOk: !webhook.error && webhook.url === `${config.baseUrl}/telegram/webhook`,
      pendingUpdates: webhook.pending_update_count ?? null,
      lastError: webhook.last_error_message ?? webhook.error ?? null,
      lastErrorAt: webhook.last_error_date ? new Date(webhook.last_error_date * 1000).toISOString() : null,
    },
    maintenance: lastMaint,
    plan: { price: config.priceStars, period: config.subscriptionPeriod },
  });
}));

adminRouter.get('/payments', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
  const { rows } = await query(
    `SELECT p.id, p.telegram_payment_charge_id, p.telegram_id, u.username, u.first_name, p.total_amount, p.currency,
            p.is_recurring, p.is_first_recurring, p.status, p.subscription_expiration_date, p.created_at
     FROM payments p LEFT JOIN users u ON u.telegram_id = p.telegram_id ORDER BY p.created_at DESC LIMIT $1`, [limit]);
  res.json({ payments: rows });
}));

adminRouter.get('/subscribers', wrap(async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 64);
  const status = String(req.query.status ?? '').toUpperCase();
  const params = [config.groupId]; const where = ['(s.group_id = $1 OR s.group_id IS NULL)'];
  if (q) {
    params.push(`%${q.replace(/^@/, '').replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    const i = params.length;
    where.push(`(u.username ILIKE $${i} OR u.first_name ILIKE $${i} OR u.telegram_id::text LIKE $${i})`);
  }
  if (['ACTIVE', 'EXPIRED', 'REVOKED'].includes(status)) { params.push(status); where.push(`s.status = $${params.length}`); }
  const { rows } = await query(
    `SELECT u.telegram_id, u.username, u.first_name, u.created_at AS user_created_at,
            s.status, s.source, s.started_at, s.expires_at, s.auto_renew, s.group_applied, s.tag_applied, s.last_sync_error, s.updated_at
     FROM users u LEFT JOIN subscriptions s ON s.telegram_id = u.telegram_id
     WHERE ${where.join(' AND ')}
     ORDER BY (s.status='ACTIVE') DESC NULLS LAST, s.expires_at DESC NULLS LAST, u.created_at DESC LIMIT 100`, params);
  res.json({ subscribers: rows });
}));

adminRouter.get('/users/:id', wrap(async (req, res) => {
  const id = userId(req.params.id);
  const [{ rows: u }, { rows: s }, { rows: p }] = await Promise.all([
    query('SELECT * FROM users WHERE telegram_id=$1', [id]),
    query('SELECT * FROM subscriptions WHERE telegram_id=$1 AND group_id=$2', [id, config.groupId]),
    query(`SELECT telegram_payment_charge_id, total_amount, currency, is_recurring, is_first_recurring, status, subscription_expiration_date, created_at
           FROM payments WHERE telegram_id=$1 ORDER BY created_at DESC LIMIT 50`, [id]),
  ]);
  if (!u.length) return res.status(404).json({ error: 'User not found' });
  let member = null;
  try { const m = await bot.api.getChatMember(config.groupId, id); member = { status: m.status, tag: m.tag ?? null, can_send_photos: m.can_send_photos ?? null, until_date: m.until_date ?? null }; } catch { /* not in group */ }
  res.json({ user: u[0], subscription: s[0] ?? null, payments: p, member });
}));

adminRouter.post('/users/:id/grant', wrap(async (req, res) => {
  const id = userId(req.params.id);
  const days = Number(req.body?.days ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ error: 'days must be an integer 1..365' });
  const r = await manualGrant(id, days);
  res.json({ ok: true, expiresAt: r.sub.expires_at, group: r.group });
}));

adminRouter.post('/users/:id/revoke', wrap(async (req, res) => {
  const id = userId(req.params.id);
  const g = await revokeSubscription(id, 'REVOKED');
  res.json({ ok: true, group: g });
}));

adminRouter.post('/maintenance', wrap(async (req, res) => res.json(await syncExpirations({ limit: 100 }))));
