// GROUP PREMIUM - single Koyeb Web Service: website + admin dashboard + Telegram webhook.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { webhookCallback } from 'grammy';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { log } from './logger.js';
import { bot, registerCommands } from './bot.js';
import { botInfoSafe } from './botInstance.js';
import { adminRouter } from './routes/admin.js';
import { syncExpirations, maybeSyncExpirations } from './subscriptions.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Koyeb terminates TLS in front of the app

const state = { dbReady: false, botReady: false, webhookSet: false, startedAt: new Date().toISOString() };

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

/* ---------- health ---------- */
app.get('/healthz', async (req, res) => {
  let db = false;
  try { await pool.query('SELECT 1'); db = true; } catch { /* reported below */ }
  res.status(200).json({ status: 'ok', db, bot: state.botReady, webhook: state.webhookSet, uptime: Math.round(process.uptime()), startedAt: state.startedAt });
});

/* ---------- Telegram webhook ---------- */
const handleUpdate = webhookCallback(bot, 'express', { secretToken: config.webhookSecret, onTimeout: 'return', timeoutMilliseconds: 9000 });
app.post('/telegram/webhook', express.json({ limit: '1mb' }), (req, res, next) => {
  // Constant-time secret check before touching grammY (grammY also verifies it).
  const got = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') || ''));
  const exp = Buffer.from(config.webhookSecret);
  if (got.length !== exp.length || !crypto.timingSafeEqual(got, exp)) return res.status(401).json({ error: 'unauthorized' });
  if (!state.botReady) return res.status(503).json({ error: 'starting' }); // Telegram will retry
  return handleUpdate(req, res, next);
});

/* ---------- maintenance (external cron) ---------- */
const maintLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });
app.post('/internal/maintenance', maintLimiter, async (req, res) => {
  const header = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '') || String(req.get('x-maintenance-secret') || '');
  const a = Buffer.from(header); const b = Buffer.from(config.maintenanceSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  if (!state.dbReady || !state.botReady) return res.status(503).json({ error: 'starting' });
  const report = await syncExpirations({ limit: 200 });
  return res.json({ ok: true, ...report, at: new Date().toISOString() });
});

/* ---------- public API + website ---------- */
const publicLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
app.get('/api/public-config', publicLimiter, (req, res) => {
  // Only non-secret values are exposed to the browser.
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    botUsername: botInfoSafe()?.username ?? null,
    groupInviteLink: config.groupInviteLink || null,
    priceStars: config.priceStars,
    periodDays: Math.round(config.subscriptionPeriod / 86400),
  });
});
app.use('/api/admin', express.json({ limit: '20kb' }), (req, res, next) => {
  maybeSyncExpirations(120).catch(() => {}); // dashboard traffic also drives expiry sync
  next();
}, adminRouter);

app.get('/admin', (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
app.use(express.static(publicDir, { index: 'index.html', maxAge: '1h', extensions: ['html'] }));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status >= 500) log.error(`Unhandled error on ${req.method} ${req.path}`, err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

/* ---------- boot ---------- */
async function boot() {
  try {
    await migrate();
    state.dbReady = true;
  } catch (e) { log.error('Database migration failed - will retry', e); setTimeout(boot, 15000); return; }
  try {
    await bot.init(); // getMe
    state.botReady = true;
    await bot.api.setWebhook(`${config.baseUrl}/telegram/webhook`, {
      secret_token: config.webhookSecret,
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'chat_member', 'my_chat_member'],
      max_connections: 10,
    });
    state.webhookSet = true;
    await registerCommands();
    log.info(`Bot @${bot.botInfo.username} ready; webhook -> ${config.baseUrl}/telegram/webhook`);
    syncExpirations().then((r) => log.info('Startup expiry sync', r)).catch(() => {});
  } catch (e) {
    log.error('Telegram initialisation failed - will retry', e.description || e.message);
    setTimeout(boot, 20000);
  }
}

const server = app.listen(config.port, '0.0.0.0', () => {
  log.info(`GROUP PREMIUM listening on 0.0.0.0:${config.port}`);
  boot();
});

function shutdown(sig) {
  log.info(`${sig} received, shutting down`);
  server.close(() => pool.end().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));
