// Payments + subscription lifecycle. All state lives in PostgreSQL.
import crypto from 'node:crypto';
import { bot, callApi } from './botInstance.js';
import { config } from './config.js';
import { pool, query, tx, upsertUser, getSetting, setSetting } from './db.js';
import { grantInGroup, revokeInGroup } from './permissions.js';
import { log } from './logger.js';

const PAYLOAD_PREFIX = 'gp1';

/* ---------------- invoice payload (HMAC-signed, <=128 bytes) ---------------- */
function sign(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url').slice(0, 22);
}
export function buildPayload(userId) {
  const nonce = crypto.randomBytes(6).toString('base64url');
  const body = `${PAYLOAD_PREFIX}:${userId}:${config.groupId}:${config.priceStars}:${nonce}`;
  return `${body}:${sign(body)}`;
}
export function parsePayload(payload) {
  if (typeof payload !== 'string' || payload.length > 128) return null;
  const parts = payload.split(':');
  if (parts.length !== 6 || parts[0] !== PAYLOAD_PREFIX) return null;
  const body = parts.slice(0, 5).join(':');
  const expected = sign(body);
  const a = Buffer.from(parts[5]); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const userId = Number(parts[1]); const groupId = Number(parts[2]); const price = Number(parts[3]);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(groupId) || !Number.isInteger(price)) return null;
  return { userId, groupId, price };
}

/* ---------------- invoice ---------------- */
export async function createSubscriptionLink(user) {
  await upsertUser(user);
  return bot.api.createInvoiceLink(
    'GROUP PREMIUM · 30 days',
    `Send photos in the group + PREMIUM member tag. ${config.priceStars} ⭐ every 30 days, renews automatically until you cancel.`,
    buildPayload(user.id),
    '', // provider_token: empty for Telegram Stars
    'XTR',
    [{ label: 'GROUP PREMIUM (30 days)', amount: config.priceStars }], // exactly one item
    { subscription_period: config.subscriptionPeriod },
  );
}

/* ---------------- validation ---------------- */
export function validateCheckout({ fromId, currency, totalAmount, payload }) {
  if (currency !== 'XTR') return 'Unsupported currency.';
  if (totalAmount !== config.priceStars) return 'Price mismatch. Please request a fresh invoice with /subscribe.';
  const p = parsePayload(payload);
  if (!p) return 'Invalid invoice. Please request a fresh invoice with /subscribe.';
  if (p.userId !== fromId) return 'This invoice was issued for a different Telegram account. Use /subscribe yourself.';
  if (p.groupId !== config.groupId) return 'This invoice belongs to another group.';
  if (p.price !== config.priceStars) return 'This invoice is outdated. Use /subscribe again.';
  return null;
}

export async function handlePreCheckout(ctx) {
  const q = ctx.preCheckoutQuery;
  let error = validateCheckout({ fromId: q.from.id, currency: q.currency, totalAmount: q.total_amount, payload: q.invoice_payload });
  if (!error) {
    try { await upsertUser(q.from); } catch (e) { log.error('DB unavailable during pre_checkout', e); error = 'Service temporarily unavailable, please try again in a minute.'; }
  }
  // Must answer within 10 seconds.
  if (error) return ctx.answerPreCheckoutQuery(false, { error_message: error });
  return ctx.answerPreCheckoutQuery(true);
}

/**
 * Process a verified successful_payment message. Idempotent: the UNIQUE
 * telegram_payment_charge_id guarantees each payment extends membership once.
 * Returns { duplicate, expiresAt, group } or throws on invalid payment.
 */
export async function processSuccessfulPayment(from, sp) {
  const err = validateCheckout({ fromId: from.id, currency: sp.currency, totalAmount: sp.total_amount, payload: sp.invoice_payload });
  if (err) {
    log.error(`Rejected successful_payment ${sp.telegram_payment_charge_id}: ${err}`);
    // Record nothing as premium; admins can refund via dashboard/BotFather if needed.
    return { rejected: err };
  }
  const now = Date.now();
  const result = await tx(async (c) => {
    await upsertUser(from, c);
    const ins = await c.query(
      `INSERT INTO payments (telegram_payment_charge_id, provider_payment_charge_id, telegram_id, group_id, currency,
         total_amount, invoice_payload, is_recurring, is_first_recurring, subscription_expiration_date, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_timestamp($10), $11)
       ON CONFLICT (telegram_payment_charge_id) DO NOTHING RETURNING id`,
      [sp.telegram_payment_charge_id, sp.provider_payment_charge_id ?? null, from.id, config.groupId, sp.currency,
        sp.total_amount, sp.invoice_payload, Boolean(sp.is_recurring), Boolean(sp.is_first_recurring),
        sp.subscription_expiration_date ?? null, JSON.stringify(sp)],
    );
    if (ins.rowCount === 0) {
      const { rows } = await c.query('SELECT expires_at FROM subscriptions WHERE telegram_id=$1 AND group_id=$2', [from.id, config.groupId]);
      return { duplicate: true, expiresAt: rows[0]?.expires_at ?? null };
    }
    const { rows } = await c.query(
      'SELECT * FROM subscriptions WHERE telegram_id=$1 AND group_id=$2 FOR UPDATE', [from.id, config.groupId]);
    const cur = rows[0];
    let expiresMs;
    if (sp.subscription_expiration_date) {
      expiresMs = sp.subscription_expiration_date * 1000; // authoritative value from Telegram
    } else {
      const base = cur && cur.status === 'ACTIVE' && cur.expires_at && cur.expires_at.getTime() > now ? cur.expires_at.getTime() : now;
      expiresMs = base + config.subscriptionPeriod * 1000;
    }
    // Never shorten an existing (e.g. manually extended) membership.
    if (cur?.status === 'ACTIVE' && cur.expires_at && cur.expires_at.getTime() > expiresMs) expiresMs = cur.expires_at.getTime();
    const isRenewal = Boolean(sp.is_recurring && !sp.is_first_recurring);
    const up = await c.query(
      `INSERT INTO subscriptions (telegram_id, group_id, status, source, started_at, expires_at, first_charge_id, last_charge_id,
         auto_renew, canceled_at, group_applied, tag_applied, updated_at)
       VALUES ($1,$2,'ACTIVE','stars', now(), to_timestamp($3::double precision / 1000), $4, $4, $5, NULL, FALSE, FALSE, now())
       ON CONFLICT (telegram_id, group_id) DO UPDATE SET
         status='ACTIVE', source='stars',
         started_at = CASE WHEN subscriptions.status='ACTIVE' AND subscriptions.started_at IS NOT NULL THEN subscriptions.started_at ELSE now() END,
         expires_at = EXCLUDED.expires_at,
         first_charge_id = CASE WHEN $6 THEN COALESCE(subscriptions.first_charge_id, EXCLUDED.first_charge_id) ELSE EXCLUDED.first_charge_id END,
         last_charge_id = EXCLUDED.last_charge_id,
         auto_renew = EXCLUDED.auto_renew,
         canceled_at = CASE WHEN $6 THEN subscriptions.canceled_at ELSE NULL END,
         group_applied = FALSE, tag_applied = FALSE, last_sync_error = NULL, updated_at = now()
       RETURNING *`,
      [from.id, config.groupId, expiresMs, sp.telegram_payment_charge_id, Boolean(sp.is_recurring), isRenewal],
    );
    return { duplicate: false, sub: up.rows[0], expiresAt: up.rows[0].expires_at, isRenewal };
  });
  if (!result.duplicate) result.group = await applyGroupGrant(from.id, result.expiresAt);
  return result;
}

/** Apply the grant to the group and record whether it stuck (retried later if not). */
export async function applyGroupGrant(userId, expiresAt) {
  const g = await grantInGroup(userId, expiresAt);
  await query(
    `UPDATE subscriptions SET group_applied=$3, tag_applied=$4, last_sync_error=$5, updated_at=now()
     WHERE telegram_id=$1 AND group_id=$2 AND status='ACTIVE'`,
    [userId, config.groupId, g.applied, g.tagged || g.reason === 'is_admin', g.reason],
  );
  return g;
}

/* ---------------- refunds ---------------- */
export async function processRefund(from, rp) {
  const { rowCount } = await query(
    `UPDATE payments SET status='REFUNDED' WHERE telegram_payment_charge_id=$1 AND status='PAID'`, [rp.telegram_payment_charge_id]);
  if (!rowCount) return false;
  await revokeSubscription(from.id, 'REVOKED');
  return true;
}

/* ---------------- cancel / resume auto-renew ---------------- */
export async function setAutoRenew(userId, enable) {
  const { rows } = await query('SELECT * FROM subscriptions WHERE telegram_id=$1 AND group_id=$2', [userId, config.groupId]);
  const sub = rows[0];
  if (!sub || sub.status !== 'ACTIVE') return { ok: false, reason: 'no_active' };
  if (sub.source !== 'stars' || !sub.first_charge_id) return { ok: false, reason: 'not_recurring' };
  if (sub.auto_renew === enable) return { ok: true, already: true, sub };
  // Telegram identifies the subscription by a charge id of that subscription.
  const ids = [...new Set([sub.first_charge_id, sub.last_charge_id].filter(Boolean))];
  let lastErr;
  for (const id of ids) {
    try {
      await callApi('editUserStarSubscription', { user_id: userId, telegram_payment_charge_id: id, is_canceled: !enable });
      lastErr = null; break;
    } catch (e) { lastErr = e; }
  }
  if (lastErr) return { ok: false, reason: lastErr.description || lastErr.message };
  const up = await query(
    `UPDATE subscriptions SET auto_renew=$3, canceled_at = CASE WHEN $3 THEN NULL ELSE now() END, updated_at=now()
     WHERE telegram_id=$1 AND group_id=$2 RETURNING *`, [userId, config.groupId, enable]);
  return { ok: true, sub: up.rows[0] };
}

/* ---------------- manual admin controls ---------------- */
export async function manualGrant(userId, days) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('days must be 1..365');
  const { rows: u } = await query('SELECT 1 FROM users WHERE telegram_id=$1', [userId]);
  if (!u.length) await query('INSERT INTO users (telegram_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const { rows } = await query(
    `INSERT INTO subscriptions (telegram_id, group_id, status, source, started_at, expires_at, auto_renew)
     VALUES ($1,$2,'ACTIVE','manual', now(), now() + make_interval(days => $3), FALSE)
     ON CONFLICT (telegram_id, group_id) DO UPDATE SET
       status='ACTIVE',
       source = CASE WHEN subscriptions.status='ACTIVE' THEN subscriptions.source ELSE 'manual' END,
       started_at = CASE WHEN subscriptions.status='ACTIVE' THEN subscriptions.started_at ELSE now() END,
       expires_at = GREATEST(COALESCE(subscriptions.expires_at, now()), now()) + make_interval(days => $3),
       group_applied=FALSE, tag_applied=FALSE, updated_at=now()
     RETURNING *`, [userId, config.groupId, d]);
  const group = await applyGroupGrant(userId, rows[0].expires_at);
  return { sub: rows[0], group };
}

/** Revoke immediately (admin action or refund). Cancels Stars auto-renew if active. */
export async function revokeSubscription(userId, status = 'REVOKED') {
  const { rows } = await query('SELECT * FROM subscriptions WHERE telegram_id=$1 AND group_id=$2', [userId, config.groupId]);
  const sub = rows[0];
  if (sub?.auto_renew) await setAutoRenew(userId, false).catch(() => {});
  await query(
    `INSERT INTO subscriptions (telegram_id, group_id, status, auto_renew) VALUES ($1,$2,$3,FALSE)
     ON CONFLICT (telegram_id, group_id) DO UPDATE SET status=$3, auto_renew=FALSE,
       expires_at = LEAST(COALESCE(subscriptions.expires_at, now()), now()), updated_at=now()`,
    [userId, config.groupId, status]).catch(async (e) => {
    if (/foreign key/i.test(e.message)) return; throw e;
  });
  const g = await revokeInGroup(userId);
  await query(`UPDATE subscriptions SET group_applied=FALSE, tag_applied=FALSE, last_sync_error=$3 WHERE telegram_id=$1 AND group_id=$2`,
    [userId, config.groupId, g.applied ? null : g.reason]);
  return g;
}

/* ---------------- expiry synchronisation ---------------- */
/**
 * Idempotent maintenance pass:
 *  1. ACTIVE subscriptions past expires_at -> remove tag + photo permission, set EXPIRED.
 *  2. EXPIRED/REVOKED rows whose group revoke previously failed -> retry.
 *  3. ACTIVE subscriptions whose grant did not stick (user joined later, API error) -> retry.
 * Protected by a Postgres advisory lock so concurrent runs never overlap.
 */
export async function syncExpirations({ limit = 50 } = {}) {
  const client = await pool.connect();
  const report = { expired: 0, retriedRevokes: 0, retriedGrants: 0, errors: 0, skipped: false };
  try {
    const { rows: lock } = await client.query('SELECT pg_try_advisory_lock(727274002) AS ok');
    if (!lock[0].ok) { report.skipped = true; return report; }
    try {
      const { rows: due } = await client.query(
        `UPDATE subscriptions SET status='EXPIRED', auto_renew=FALSE, group_applied=TRUE, updated_at=now()
         WHERE id IN (SELECT id FROM subscriptions WHERE status='ACTIVE' AND expires_at <= now() ORDER BY expires_at LIMIT $1)
         RETURNING telegram_id`, [limit]);
      for (const r of due) {
        const g = await revokeInGroup(r.telegram_id);
        report.expired++;
        if (!g.applied) { report.errors++; await client.query(`UPDATE subscriptions SET group_applied=FALSE, last_sync_error=$2 WHERE telegram_id=$1 AND group_id=$3`, [r.telegram_id, g.reason, config.groupId]); }
        else await client.query(`UPDATE subscriptions SET tag_applied=FALSE, last_sync_error=NULL WHERE telegram_id=$1 AND group_id=$2`, [r.telegram_id, config.groupId]);
        notify(r.telegram_id, '⌛ Your <b>GROUP PREMIUM</b> membership has ended. Photo sending is now off and your PREMIUM tag was removed. Text chat stays available.\n\nRejoin any time with /subscribe.');
      }
      const { rows: badRevoke } = await client.query(
        `SELECT telegram_id FROM subscriptions WHERE status IN ('EXPIRED','REVOKED') AND group_applied=FALSE AND last_sync_error IS NOT NULL
         AND updated_at < now() - interval '2 minutes' LIMIT $1`, [limit]);
      for (const r of badRevoke) {
        const g = await revokeInGroup(r.telegram_id);
        report.retriedRevokes++;
        await client.query(`UPDATE subscriptions SET group_applied=$2, last_sync_error=$3, updated_at=now() WHERE telegram_id=$1 AND group_id=$4`,
          [r.telegram_id, g.applied, g.applied ? null : g.reason, config.groupId]);
      }
      const { rows: pending } = await client.query(
        `SELECT telegram_id, expires_at FROM subscriptions WHERE status='ACTIVE' AND expires_at > now() + interval '2 minutes'
         AND (group_applied=FALSE OR tag_applied=FALSE) AND updated_at < now() - interval '2 minutes' LIMIT $1`, [limit]);
      for (const r of pending) { await applyGroupGrant(r.telegram_id, r.expires_at); report.retriedGrants++; }
      await client.query('DELETE FROM admin_sessions WHERE expires_at < now()');
      await setSetting('last_maintenance', { at: new Date().toISOString(), ...report }, client);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274002)');
    }
  } catch (e) {
    report.errors++; log.error('syncExpirations failed', e);
  } finally {
    client.release();
  }
  return report;
}

/** Run expiry sync at most once every `minSeconds`, coordinated via the DB (survives restarts). */
export async function maybeSyncExpirations(minSeconds = 60) {
  try {
    const { rowCount } = await query(
      `INSERT INTO bot_settings (key, value, updated_at) VALUES ('opportunistic_sync', '{}'::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET updated_at = now()
       WHERE bot_settings.updated_at < now() - make_interval(secs => $1)`, [minSeconds]);
    if (rowCount) await syncExpirations({ limit: 20 });
  } catch (e) { log.warn('opportunistic sync skipped', e.message); }
}

function notify(userId, html) {
  bot.api.sendMessage(userId, html, { parse_mode: 'HTML' }).catch(() => {});
}

/* ---------------- read helpers ---------------- */
export async function getSubscription(userId) {
  const { rows } = await query('SELECT * FROM subscriptions WHERE telegram_id=$1 AND group_id=$2', [userId, config.groupId]);
  return rows[0] ?? null;
}

export async function getStats() {
  const { rows } = await query(`SELECT
    (SELECT count(*) FROM subscriptions WHERE status='ACTIVE' AND expires_at > now())::int AS active,
    (SELECT count(*) FROM subscriptions WHERE status='EXPIRED' OR (status='ACTIVE' AND expires_at <= now()))::int AS expired,
    (SELECT count(*) FROM subscriptions WHERE status='REVOKED')::int AS revoked,
    (SELECT count(*) FROM subscriptions WHERE status='ACTIVE' AND auto_renew)::int AS auto_renew,
    (SELECT count(*) FROM payments WHERE status='PAID')::int AS payments,
    (SELECT COALESCE(sum(total_amount),0) FROM payments WHERE status='PAID')::int AS stars,
    (SELECT count(*) FROM users)::int AS users`);
  return rows[0];
}

export { getSetting };
