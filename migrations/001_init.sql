-- GROUP PREMIUM initial schema
CREATE TABLE IF NOT EXISTS users (
  telegram_id     BIGINT PRIMARY KEY,
  username        TEXT,
  first_name      TEXT,
  last_name       TEXT,
  is_bot_blocked  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                          BIGSERIAL PRIMARY KEY,
  telegram_id                 BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  group_id                    BIGINT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'NONE'
                              CHECK (status IN ('NONE','ACTIVE','EXPIRED','REVOKED')),
  source                      TEXT NOT NULL DEFAULT 'stars' CHECK (source IN ('stars','manual')),
  started_at                  TIMESTAMPTZ,
  expires_at                  TIMESTAMPTZ,
  first_charge_id             TEXT,
  last_charge_id              TEXT,
  auto_renew                  BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at                 TIMESTAMPTZ,
  group_applied               BOOLEAN NOT NULL DEFAULT FALSE,
  tag_applied                 BOOLEAN NOT NULL DEFAULT FALSE,
  last_sync_error             TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (telegram_id, group_id)
);
CREATE INDEX IF NOT EXISTS subscriptions_status_expires_idx ON subscriptions (status, expires_at);

CREATE TABLE IF NOT EXISTS payments (
  id                          BIGSERIAL PRIMARY KEY,
  telegram_payment_charge_id  TEXT NOT NULL UNIQUE,
  provider_payment_charge_id  TEXT,
  telegram_id                 BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  group_id                    BIGINT NOT NULL,
  currency                    TEXT NOT NULL,
  total_amount                INTEGER NOT NULL,
  invoice_payload             TEXT NOT NULL,
  is_recurring                BOOLEAN NOT NULL DEFAULT FALSE,
  is_first_recurring          BOOLEAN NOT NULL DEFAULT FALSE,
  subscription_expiration_date TIMESTAMPTZ,
  status                      TEXT NOT NULL DEFAULT 'PAID' CHECK (status IN ('PAID','REFUNDED')),
  raw                         JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (telegram_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_created_idx ON payments (created_at DESC);

CREATE TABLE IF NOT EXISTS bot_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id            BIGSERIAL PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  telegram_id   BIGINT NOT NULL,
  ip            TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_idx ON admin_sessions (expires_at);

-- Admin dashboard credentials (scrypt hashes). One row per admin Telegram id.
CREATE TABLE IF NOT EXISTS admin_credentials (
  telegram_id    BIGINT PRIMARY KEY,
  password_hash  TEXT NOT NULL,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
