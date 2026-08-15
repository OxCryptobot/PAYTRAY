-- PayTray Batch BO durable v2 extension hooks for outbox workers

CREATE TABLE IF NOT EXISTS extension_hooks (
  id VARCHAR(255) PRIMARY KEY,
  owner_wallet VARCHAR(255) NOT NULL,
  api_version VARCHAR(16) NOT NULL,
  contract_version VARCHAR(64) NOT NULL,
  event VARCHAR(128) NOT NULL,
  callback_url TEXT NOT NULL,
  projections JSONB NOT NULL DEFAULT '[]'::jsonb,
  replay_window_seconds INTEGER NOT NULL,
  delivery JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (api_version = 'v2'),
  CHECK (replay_window_seconds BETWEEN 60 AND 86400)
);

CREATE INDEX IF NOT EXISTS extension_hooks_event_active_index
  ON extension_hooks (event, active, created_at ASC);

CREATE INDEX IF NOT EXISTS extension_hooks_owner_index
  ON extension_hooks (owner_wallet, active, created_at DESC);
