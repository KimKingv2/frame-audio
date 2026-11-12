CREATE TABLE IF NOT EXISTS connection_settings (
  id TEXT PRIMARY KEY NOT NULL CHECK (id = 'openlist'),
  encrypted_value TEXT NOT NULL,
  nonce TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
