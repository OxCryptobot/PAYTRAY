-- PayTray Batch G durable verifier worker cursors

CREATE TABLE IF NOT EXISTS payment_verifier_cursors (
  chain_id BIGINT PRIMARY KEY,
  last_scanned_block BIGINT NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (last_scanned_block >= 0)
);
