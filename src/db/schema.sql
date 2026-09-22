-- Applied on every boot; every statement is idempotent so it doubles as the
-- migration for a fresh volume and a no-op for an existing one.

CREATE TABLE IF NOT EXISTS watchlist (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol      TEXT        NOT NULL,
  owner       TEXT        NOT NULL DEFAULT 'default',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT watchlist_owner_symbol_key UNIQUE (owner, symbol)
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

-- The poller only ever scans active rows.
CREATE INDEX IF NOT EXISTS alerts_active_symbol_idx ON alerts (symbol) WHERE active;
