-- PayTray Batch C verifier-owned payment-stream provenance

ALTER TABLE payment_streams
  ADD COLUMN IF NOT EXISTS last_verified_event JSONB NOT NULL DEFAULT '{}'::jsonb;
