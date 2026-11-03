// Integration test for payment verification, idempotency, renewal and expiry sync.
// Needs a THROWAWAY Postgres database:  DATABASE_URL=postgres://... DATABASE_SSL=false npm test
// Telegram calls use a fake token and fail harmlessly (the logic records them as pending/retry).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.BOT_TOKEN ||= '123456789:AAFakeTokenForLocalTestingOnly_xxxxxxxxxx';
process.env.GROUP_ID ||= '-1001234567890';
process.env.ADMIN_TELEGRAM_IDS ||= '111111';
process.env.WEBHOOK_SECRET ||= 'a'.repeat(40);
process.env.SESSION_SECRET ||= 's'.repeat(48);
process.env.BASE_URL ||= 'https://example.koyeb.app';
process.env.MAINTENANCE_SECRET ||= 'm'.repeat(32);

const { migrate } = await import('../src/migrate.js');
const { pool, query } = await import('../src/db.js');
const S = await import('../src/subscriptions.js');
const { hashPassword, verifyPassword } = await import('../src/auth.js');

await migrate();
const uid = 900000000 + Math.floor(Math.random() * 99999);
const from = { id: uid, first_name: 'Test', username: 'tester' };
after(async () => { await query('DELETE FROM users WHERE telegram_id=$1', [uid]); await pool.end(); });

test('payload is signed and bound to user', () => {
  const p = S.buildPayload(uid);
  assert.ok(Buffer.byteLength(p) <= 128);
  assert.equal(S.validateCheckout({ fromId: uid, currency: 'XTR', totalAmount: 99, payload: p }), null);
  assert.ok(S.validateCheckout({ fromId: uid + 1, currency: 'XTR', totalAmount: 99, payload: p }));
  assert.ok(S.validateCheckout({ fromId: uid, currency: 'USD', totalAmount: 99, payload: p }));
  assert.ok(S.validateCheckout({ fromId: uid, currency: 'XTR', totalAmount: 1, payload: p }));
  assert.ok(S.validateCheckout({ fromId: uid, currency: 'XTR', totalAmount: 99, payload: p.slice(0, -2) + 'xx' }));
});

test('first payment activates, duplicate is ignored, renewal extends', async () => {
  const exp1 = Math.floor(Date.now() / 1000) + 2592000;
  const sp = { currency: 'XTR', total_amount: 99, invoice_payload: S.buildPayload(uid), telegram_payment_charge_id: `t-${uid}-1`,
    provider_payment_charge_id: 'x', is_recurring: true, is_first_recurring: true, subscription_expiration_date: exp1 };
  const r1 = await S.processSuccessfulPayment(from, sp);
  assert.equal(r1.duplicate, false);
  assert.equal(Math.round(new Date(r1.expiresAt).getTime() / 1000), exp1);
  const r2 = await S.processSuccessfulPayment(from, sp);
  assert.equal(r2.duplicate, true);
  const { rows } = await query('SELECT count(*)::int n FROM payments WHERE telegram_id=$1', [uid]);
  assert.equal(rows[0].n, 1);
  const sub = await S.getSubscription(uid);
  assert.equal(sub.status, 'ACTIVE'); assert.equal(sub.auto_renew, true); assert.equal(sub.first_charge_id, `t-${uid}-1`);

  const exp2 = exp1 + 2592000;
  const r3 = await S.processSuccessfulPayment(from, { ...sp, telegram_payment_charge_id: `t-${uid}-2`, is_first_recurring: undefined, subscription_expiration_date: exp2 });
  assert.equal(r3.isRenewal, true);
  const sub2 = await S.getSubscription(uid);
  assert.equal(Math.round(sub2.expires_at.getTime() / 1000), exp2);
  assert.equal(sub2.first_charge_id, `t-${uid}-1`); assert.equal(sub2.last_charge_id, `t-${uid}-2`);
});

test('invalid successful_payment is rejected and grants nothing', async () => {
  const r = await S.processSuccessfulPayment({ id: uid + 1, first_name: 'X' }, { currency: 'XTR', total_amount: 99, invoice_payload: S.buildPayload(uid), telegram_payment_charge_id: `t-${uid}-bad` });
  assert.ok(r.rejected);
});

test('expiry sync marks EXPIRED and is repeatable', async () => {
  await query(`UPDATE subscriptions SET expires_at = now() - interval '1 minute' WHERE telegram_id=$1`, [uid]);
  const r = await S.syncExpirations();
  assert.ok(r.expired >= 1);
  assert.equal((await S.getSubscription(uid)).status, 'EXPIRED');
  const again = await S.syncExpirations();
  assert.equal(again.expired, 0);
});

test('password hashing', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(await verifyPassword('correct horse battery', h));
  assert.ok(!(await verifyPassword('wrong', h)));
});
