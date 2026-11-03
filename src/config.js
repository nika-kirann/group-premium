import crypto from 'node:crypto';
// Centralised, validated configuration. All secrets come from environment variables.
function req(name) {
  const v = process.env[name];
  if (v === undefined || String(v).trim() === '') throw new Error(`Missing required environment variable ${name}`);
  return String(v).trim();
}
function int(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

// Optional secret: use the env value if valid, otherwise derive a stable strong value from BOT_TOKEN.
function secret(name, valid) {
  const v = (process.env[name] || '').trim();
  if (v && valid(v)) return v;
  const token = (process.env.BOT_TOKEN || '').trim();
  if (!token) throw new Error(`Missing ${name} and BOT_TOKEN to derive it from`);
  if (v) console.warn(`[config] ${name} is invalid; using a value derived from BOT_TOKEN instead`);
  return crypto.createHmac('sha256', token).update('group-premium:' + name).digest('base64url');
}

export function loadConfig() {
  const errors = [];
  const get = (fn) => { try { return fn(); } catch (e) { errors.push(e.message); return undefined; } };

  const cfg = {
    botToken: get(() => req('BOT_TOKEN')),
    groupId: get(() => { const g = Number(req('GROUP_ID')); if (!Number.isInteger(g) || g >= 0) throw new Error('GROUP_ID must be a negative integer like -100xxxxxxxxxx'); return g; }),
    adminIds: get(() => req('ADMIN_TELEGRAM_IDS').split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const n = Number(s); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ADMIN_TELEGRAM_IDS must be comma-separated positive integers'); return n; })),
    databaseUrl: get(() => req('DATABASE_URL')),
    webhookSecret: get(() => secret('WEBHOOK_SECRET', (s) => /^[A-Za-z0-9_-]{32,256}$/.test(s))),
    sessionSecret: get(() => secret('SESSION_SECRET', (s) => s.length >= 32)),
    baseUrl: get(() => { const u = req('BASE_URL').replace(/\/+$/, ''); if (!/^https?:\/\//.test(u)) throw new Error('BASE_URL must start with https://'); return u; }),
    priceStars: get(() => { const p = int('PRICE_STARS', 99); if (p < 1 || p > 10000) throw new Error('PRICE_STARS must be 1..10000'); return p; }),
    subscriptionPeriod: get(() => { const p = int('SUBSCRIPTION_PERIOD', 2592000); if (p !== 2592000) throw new Error('SUBSCRIPTION_PERIOD must be 2592000 (Telegram only accepts 30 days)'); return p; }),
    maintenanceSecret: get(() => secret('MAINTENANCE_SECRET', (s) => s.length >= 24)),
    port: int('PORT', 8000),
    groupInviteLink: (process.env.GROUP_INVITE_LINK || '').trim(),
    photoMode: (process.env.PHOTO_MODE || 'native').trim().toLowerCase(),
    databaseSsl: String(process.env.DATABASE_SSL ?? 'true').toLowerCase() !== 'false',
    isProduction: process.env.NODE_ENV === 'production',
    premiumTag: 'PREMIUM',
  };
  if (!['native', 'guard'].includes(cfg.photoMode)) errors.push('PHOTO_MODE must be "native" or "guard"');
  if (cfg.groupInviteLink && !/^https:\/\/t\.me\//.test(cfg.groupInviteLink)) errors.push('GROUP_INVITE_LINK must start with https://t.me/');
  if (errors.length) {
    const err = new Error('Invalid configuration:\n  - ' + errors.join('\n  - '));
    err.configErrors = errors;
    throw err;
  }
  return Object.freeze(cfg);
}

export const config = loadConfig();
export const isAdmin = (id) => config.adminIds.includes(Number(id));
