-- PayTray Batch BL durable shared webhook replay claims

CREATE TABLE IF NOT EXISTS webhook_replay_claims (
  replay_key VARCHAR(512) PRIMARY KEY,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS webhook_replay_claims_expiry_index
  ON webhook_replay_claims (expires_at);
