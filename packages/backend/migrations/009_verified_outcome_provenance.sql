-- PayTray Phase 3 verified outcome provenance

ALTER TABLE engagement_outcome_events
  ADD COLUMN IF NOT EXISTS verification_actor_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS verification_evidence_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS engagement_outcome_events_verified_index
  ON engagement_outcome_events (verification_status, verified_at DESC);
