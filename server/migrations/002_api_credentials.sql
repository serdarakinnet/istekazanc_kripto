CREATE TABLE IF NOT EXISTS user_api_credentials (
  user_id UUID PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  api_key_enc JSONB NOT NULL,
  api_secret_enc JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_api_credentials_updated_at ON user_api_credentials (updated_at_ms DESC);
