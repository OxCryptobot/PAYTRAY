-- PayTray Batch BN durable webhook inbox state machine

CREATE TABLE IF NOT EXISTS webhook_inbox (
  replay_key VARCHAR(512) PRIMARY KEY,
  event_id VARCHAR(255),
  hook_id VARCHAR(255),
  event_type VARCHAR(128) NOT NULL,
  body_sha256 CHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(16) NOT NULL DEFAULT 'claimed',
  attempts INTEGER NOT NULL DEFAULT 1,
  lease_until TIMESTAMP,
  next_attempt_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error VARCHAR(500),
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('claimed', 'processed', 'retryable', 'quarantined')),
  CHECK (attempts >= 1)
);

CREATE INDEX IF NOT EXISTS webhook_inbox_due_index
  ON webhook_inbox (next_attempt_at, lease_until)
  WHERE status IN ('claimed', 'retryable');

CREATE INDEX IF NOT EXISTS webhook_inbox_status_index
  ON webhook_inbox (status, updated_at DESC);
