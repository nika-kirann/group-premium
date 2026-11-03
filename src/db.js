import pg from 'pg';
import { config } from './config.js';
import { log } from './logger.js';

// pg returns BIGINT as string by default; Telegram ids fit in JS safe integers.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: 5, // small pool for free tiers
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (err) => log.error('Postgres pool error', err));

export const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction; rolls back on error. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function getSetting(key, def = null) {
  const { rows } = await query('SELECT value FROM bot_settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : def;
}
export async function setSetting(key, value, client = pool) {
  await client.query(
    `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function upsertUser(u, client = pool) {
  if (!u || !u.id || u.is_bot) return;
  await client.query(
    `INSERT INTO users (telegram_id, username, first_name, last_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username, first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name, updated_at = now()
     WHERE users.username IS DISTINCT FROM EXCLUDED.username
        OR users.first_name IS DISTINCT FROM EXCLUDED.first_name
        OR users.last_name IS DISTINCT FROM EXCLUDED.last_name`,
    [u.id, u.username ?? null, (u.first_name ?? '').slice(0, 128), u.last_name ?? null],
  );
}
