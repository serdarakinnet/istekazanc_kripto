ALTER TABLE user_settings
ADD COLUMN IF NOT EXISTS custom_strategy_code TEXT;
