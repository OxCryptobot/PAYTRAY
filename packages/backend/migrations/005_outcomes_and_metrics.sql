-- PayTray Phase 2 verified outcome and pilot measurement records

CREATE TABLE IF NOT EXISTS engagement_outcome_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  engagement_id UUID NOT NULL REFERENCES engagements(id) ON DELETE RESTRICT,
  event_type VARCHAR(64) NOT NULL,
  actor_type VARCHAR(32) NOT NULL,
  actor_id VARCHAR(255),
  evidence_type VARCHAR(64) NOT NULL,
  evidence_id VARCHAR(255),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  verification_status VARCHAR(32) NOT NULL DEFAULT 'unverified',
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (event_type IN ('meeting_completed', 'paid_minutes_delivered', 'no_show', 'dispute_opened', 'repeat_booking')),
  CHECK (actor_type IN ('client', 'provider', 'verifier', 'system', 'operator')),
  CHECK (verification_status IN ('unverified', 'verified', 'rejected')),
  CHECK (evidence_type IN ('session', 'payment_chain_event', 'ledger_entry', 'dispute_record', 'engagement')),
  UNIQUE (engagement_id, event_type, evidence_type, evidence_id)
);

CREATE INDEX IF NOT EXISTS engagement_outcome_events_metric_index
  ON engagement_outcome_events (event_type, verification_status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS engagement_outcome_events_engagement_index
  ON engagement_outcome_events (engagement_id, occurred_at DESC);
