CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  email CITEXT NOT NULL UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id UUID PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auto_trade_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  min_risk_reward DOUBLE PRECISION NOT NULL DEFAULT 1.5,
  updated_at_ms BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
);

CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  opened_at_ms BIGINT NOT NULL,
  payload_json JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_user_opened_at ON positions (user_id, opened_at_ms DESC);

CREATE TABLE IF NOT EXISTS trade_reports (
  id TEXT PRIMARY KEY NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  opened_at_ms BIGINT NOT NULL,
  closed_at_ms BIGINT NOT NULL,
  entry DOUBLE PRECISION NOT NULL,
  exit DOUBLE PRECISION NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('TP', 'SL')),
  pnl_pct DOUBLE PRECISION NOT NULL,
  risk_reward_at_entry DOUBLE PRECISION NOT NULL,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_reports_user_closed_at ON trade_reports (user_id, closed_at_ms DESC);

CREATE TABLE IF NOT EXISTS binance_ticker_prices (
  id BIGSERIAL PRIMARY KEY NOT NULL,
  symbol TEXT NOT NULL,
  price DOUBLE PRECISION NOT NULL,
  event_at_ms BIGINT NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  created_at_ms BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_binance_ticker_symbol_event ON binance_ticker_prices (symbol, event_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_binance_ticker_user_event ON binance_ticker_prices (user_id, event_at_ms DESC);
