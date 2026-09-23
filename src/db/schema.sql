-- Applied on every boot; every statement is idempotent so it doubles as the
-- migration for a fresh volume and a no-op for an existing one.

-- Created first: both tables below reference it.
CREATE TABLE IF NOT EXISTS users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT        NOT NULL UNIQUE,
  password_hash  TEXT        NOT NULL,
  -- Bumped to revoke every token already issued to this user. Each token
  -- carries the value it was signed with; the authenticate hook compares.
  token_version  INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlist (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol      TEXT        NOT NULL,
  owner_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT watchlist_owner_symbol_key UNIQUE (owner_id, symbol)
);

CREATE TABLE IF NOT EXISTS alerts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol           TEXT           NOT NULL,
  -- 'above' fires when price >= target, 'below' when price <= target.
  direction        TEXT           NOT NULL CHECK (direction IN ('above', 'below')),
  target_price     NUMERIC(18, 6) NOT NULL CHECK (target_price > 0),
  webhook_url      TEXT,
  email            TEXT,
  active           BOOLEAN        NOT NULL DEFAULT TRUE,
  -- Fired-state: non-null means the alert already notified and stays quiet
  -- until the price crosses back to the other side (re-arm).
  fired_at         TIMESTAMPTZ,
  last_price       NUMERIC(18, 6),
  last_checked_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT now(),
  -- An alert with no channel would fire into the void.
  CONSTRAINT alerts_needs_channel CHECK (webhook_url IS NOT NULL OR email IS NOT NULL)
);

-- Added separately: IF NOT EXISTS on a column works on an existing table,
-- unlike the CREATE TABLE above.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS owner_id BIGINT REFERENCES users(id) ON DELETE CASCADE;

-- The poller only ever scans active rows.
CREATE INDEX IF NOT EXISTS alerts_active_symbol_idx ON alerts (symbol) WHERE active;

-- Every HTTP read of alerts is scoped to one owner.
CREATE INDEX IF NOT EXISTS alerts_owner_idx ON alerts (owner_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
