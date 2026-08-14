-- PayTray Phase 3 Weeks 5-6 production telemetry ingestion

CREATE TABLE IF NOT EXISTS production_telemetry_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  occurred_at TIMESTAMP NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  actor_scope VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id VARCHAR(255) NOT NULL,
  correlation_id UUID,
  schema_version VARCHAR(32) NOT NULL,
  source VARCHAR(64) NOT NULL,
  privacy_class VARCHAR(32) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash CHAR(64) NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (event_type IN ('discovery_impression', 'match_selected', 'engagement_created', 'collaboration_state_changed', 'payment_intent_created', 'payment_chain_event_verified', 'ledger_entry_reflected', 'outcome_verified', 'shadow_evaluation_completed')),
  CHECK (privacy_class IN ('operational', 'derived_non_content', 'sensitive_derived', 'restricted')),
  UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS production_telemetry_type_time_index
  ON production_telemetry_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS production_telemetry_entity_index
  ON production_telemetry_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS production_telemetry_lag_index
  ON production_telemetry_events (received_at, occurred_at);
