// Admin authentication: scrypt password hashes + DB-backed sessions with signed, httpOnly cookies.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config, isAdmin } from './config.js';
import { query } from './db.js';

const scrypt = promisify(crypto.scrypt);
const COOKIE = config.isProduction ? '__Host-gp_session' : 'gp_session';
const SESSION_HOURS = 12;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw, stored) {
  const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(pw.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(key, expected);
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mac = (s) => crypto.createHmac('sha256', config.sessionSecret).update(s).digest('base64url');
// A dummy hash so unknown users take the same time as real ones (no user enumeration by timing).
const DUMMY = await hashPassword(crypto.randomBytes(16).toString('hex'));

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function login(req, res, telegramId, password) {
  const id = Number(telegramId);
  const generic = { ok: false, status: 401, error: 'Invalid Telegram ID or password.' };
  if (!Number.isSafeInteger(id) || id <= 0 || typeof password !== 'string' || password.length < 1 || password.length > 128) {
    return { ok: false, status: 400, error: 'Invalid input.' };
  }
  const { rows } = isAdmin(id) ? await query('SELECT * FROM admin_credentials WHERE telegram_id=$1', [id]) : { rows: [] };
  const cred = rows[0];
  if (cred?.locked_until && new Date(cred.locked_until) > new Date()) return { ok: false, status: 429, error: 'Too many failed attempts. Try again later.' };
  const good = await verifyPassword(password, cred?.password_hash ?? DUMMY);
  if (!cred || !good || !isAdmin(id)) {
    if (cred) {
      await query(`UPDATE admin_credentials SET failed_logins = failed_logins + 1,
        locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END WHERE telegram_id=$1`, [id]);
    }
    return generic;
  }
  await query('UPDATE admin_credentials SET failed_logins=0, locked_until=NULL WHERE telegram_id=$1', [id]);
  const token = crypto.randomBytes(32).toString('base64url');
  await query(`INSERT INTO admin_sessions (token_hash, telegram_id, ip, user_agent, expires_at)
    VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))`,
  [sha(token), id, req.ip, String(req.get('user-agent') || '').slice(0, 300), SESSION_HOURS]);
  res.cookie(COOKIE, `${token}.${mac(token)}`, {
    httpOnly: true, secure: config.isProduction, sameSite: 'strict', path: '/', maxAge: SESSION_HOURS * 3600 * 1000,
  });
  return { ok: true, telegramId: id };
}

export async function logout(req, res) {
  const s = await readSession(req);
  if (s) await query('DELETE FROM admin_sessions WHERE token_hash=$1', [s.tokenHash]);
  res.clearCookie(COOKIE, { path: '/', httpOnly: true, secure: config.isProduction, sameSite: 'strict' });
}

async function readSession(req) {
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  if (!raw) return null;
  const [token, sig] = raw.split('.');
  if (!token || !sig) return null;
  const a = Buffer.from(sig); const b = Buffer.from(mac(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const tokenHash = sha(token);
  const { rows } = await query('SELECT telegram_id FROM admin_sessions WHERE token_hash=$1 AND expires_at > now()', [tokenHash]);
  if (!rows.length || !isAdmin(rows[0].telegram_id)) return null;
  return { telegramId: rows[0].telegram_id, tokenHash };
}

/** Express middleware protecting admin API routes (+ CSRF header check for writes). */
export async function requireAdmin(req, res, next) {
  try {
    const s = await readSession(req);
    if (!s) return res.status(401).json({ error: 'Not authenticated' });
    if (req.method !== 'GET' && req.get('x-requested-with') !== 'group-premium') return res.status(403).json({ error: 'CSRF check failed' });
    req.admin = s;
    return next();
  } catch (e) { return next(e); }
}
