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

export function loadConfig() {
  const errors = [];
  const get = (fn) => { try { return fn(); } catch (e) { errors.push(e.message); return undefined; } };

  const cfg = {
    botToken: get(() => req('BOT_TOKEN')),
    groupId: get(() => { const g = Number(req('GROUP_ID')); if (!Number.isInteger(g) || g >= 0) throw new Error('GROUP_ID must be a negative integer like -100xxxxxxxxxx'); return g; }),
    adminIds: get(() => req('ADMIN_TELEGRAM_IDS').split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const n = Number(s); if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ADMIN_TELEGRAM_IDS must be comma-separated positive integers'); return n; })),
    databaseUrl: get(() => req('DATABASE_URL')),
    webhookSecret: get(() => { const s = req('WEBHOOK_SECRET'); if (!/^[A-Za-z0-9_-]{32,256}$/.test(s)) throw new Error('WEBHOOK_SECRET must be 32-256 chars of A-Z a-z 0-9 _ -'); return s; }),
    sessionSecret: get(() => { const s = req('SESSION_SECRET'); if (s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters'); return s; }),
    baseUrl: get(() => { const u = req('BASE_URL').replace(/\/+$/, ''); if (!/^https?:\/\//.test(u)) throw new Error('BASE_URL must start with https://'); return u; }),
    priceStars: get(() => { const p = int('PRICE_STARS', 99); if (p < 1 || p > 10000) throw new Error('PRICE_STARS must be 1..10000'); return p; }),
    subscriptionPeriod: get(() => { const p = int('SUBSCRIPTION_PERIOD', 2592000); if (p !== 2592000) throw new Error('SUBSCRIPTION_PERIOD must be 2592000 (Telegram only accepts 30 days)'); return p; }),
    maintenanceSecret: get(() => { const s = req('MAINTENANCE_SECRET'); if (s.length < 24) throw new Error('MAINTENANCE_SECRET must be at least 24 characters'); return s; }),
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
