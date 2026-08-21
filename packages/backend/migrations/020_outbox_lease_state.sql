-- PayTray Batch migration-020 durable outbox lease ownership and terminal state
ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_acquired_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMP;

-- Preserve historical attempt evidence before enforcing the new shape contract.
UPDATE outbox_events
   SET last_attempt_at = COALESCE(last_attempt_at, occurred_at)
 WHERE attempts > 0
   AND last_attempt_at IS NULL;

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_lease_shape_check,
  DROP CONSTRAINT IF EXISTS outbox_events_processed_lease_check,
  DROP CONSTRAINT IF EXISTS outbox_events_dead_letter_check,
  DROP CONSTRAINT IF EXISTS outbox_events_attempt_timestamp_check;

ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_lease_shape_check CHECK (
    (lease_token IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
    OR
    (lease_token IS NOT NULL AND lease_acquired_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > lease_acquired_at)
  ),
  ADD CONSTRAINT outbox_events_processed_lease_check CHECK (
    processed_at IS NULL OR (lease_token IS NULL AND lease_acquired_at IS NULL AND lease_expires_at IS NULL)
  ),
  ADD CONSTRAINT outbox_events_dead_letter_check CHECK (
    dead_lettered_at IS NULL OR (processed_at IS NULL AND attempts > 0)
  ),
  ADD CONSTRAINT outbox_events_attempt_timestamp_check CHECK (
    (attempts = 0 AND last_attempt_at IS NULL)
    OR
    (attempts > 0 AND last_attempt_at IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS outbox_events_lease_expiry_index
  ON outbox_events (lease_expires_at, available_at)
  WHERE processed_at IS NULL AND lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbox_events_dead_letter_index
  ON outbox_events (dead_lettered_at, occurred_at)
  WHERE processed_at IS NULL AND dead_lettered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS outbox_events_attempt_index
  ON outbox_events (last_attempt_at DESC)
  WHERE processed_at IS NULL;
