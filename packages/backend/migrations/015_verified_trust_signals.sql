-- PayTray Batch BM verifier-owned durable trust signals

CREATE TABLE IF NOT EXISTS verified_trust_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_wallet_address VARCHAR(255) NOT NULL,
  engagement_id UUID NOT NULL REFERENCES engagements(id) ON DELETE RESTRICT,
  outcome_id UUID NOT NULL REFERENCES engagement_outcome_events(id) ON DELETE RESTRICT,
  signal_type VARCHAR(64) NOT NULL,
  polarity VARCHAR(16) NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  eligible_for_ranking BOOLEAN NOT NULL DEFAULT false,
  evidence_hash CHAR(64) NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (polarity IN ('positive', 'neutral')),
  CHECK (score >= 0),
  UNIQUE (subject_user_id, outcome_id, signal_type)
);

CREATE INDEX IF NOT EXISTS verified_trust_signals_subject_index
  ON verified_trust_signals (subject_wallet_address, created_at DESC);

CREATE INDEX IF NOT EXISTS verified_trust_signals_outcome_index
  ON verified_trust_signals (outcome_id, created_at DESC);
