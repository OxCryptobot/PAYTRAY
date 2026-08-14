-- PayTray Phase 3 Weeks 1-2 AI data and evaluation foundation

CREATE TABLE IF NOT EXISTS ai_feature_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type VARCHAR(64) NOT NULL,
  entity_id UUID NOT NULL,
  feature_version VARCHAR(64) NOT NULL,
  as_of TIMESTAMP NOT NULL,
  features JSONB NOT NULL,
  source_event_ids UUID[] NOT NULL DEFAULT '{}',
  source_hash CHAR(64) NOT NULL,
  privacy_class VARCHAR(32) NOT NULL DEFAULT 'derived_non_content',
  retention_until TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (entity_type IN ('expert_profile', 'engagement', 'payment_stream', 'conversation')),
  CHECK (privacy_class IN ('derived_non_content', 'sensitive_derived', 'restricted')),
  UNIQUE (entity_type, entity_id, feature_version, as_of)
);

CREATE INDEX IF NOT EXISTS ai_feature_snapshots_entity_time_index
  ON ai_feature_snapshots (entity_type, entity_id, as_of DESC);

CREATE TABLE IF NOT EXISTS ai_evaluation_examples (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  dataset_version VARCHAR(64) NOT NULL,
  query_id VARCHAR(255) NOT NULL,
  candidate_profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  engagement_id UUID REFERENCES engagements(id) ON DELETE RESTRICT,
  label_type VARCHAR(64) NOT NULL,
  label_value NUMERIC(12, 6) NOT NULL,
  label_verification_status VARCHAR(32) NOT NULL,
  split VARCHAR(16) NOT NULL,
  as_of TIMESTAMP NOT NULL,
  source_event_ids UUID[] NOT NULL DEFAULT '{}',
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (label_type IN ('selected', 'conversation_started', 'payment_intent', 'completed', 'repeat_booking', 'disputed')),
  CHECK (label_verification_status IN ('verified', 'unverified', 'rejected')),
  CHECK (split IN ('train', 'validation', 'test', 'shadow')),
  CHECK (label_value >= 0),
  UNIQUE (dataset_version, query_id, candidate_profile_id, split)
);

CREATE INDEX IF NOT EXISTS ai_evaluation_examples_dataset_index
  ON ai_evaluation_examples (dataset_version, split, label_type);

CREATE TABLE IF NOT EXISTS ai_evaluation_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_type VARCHAR(64) NOT NULL,
  model_name VARCHAR(128) NOT NULL,
  model_version VARCHAR(128) NOT NULL,
  baseline_version VARCHAR(128) NOT NULL,
  dataset_version VARCHAR(64) NOT NULL,
  time_split JSONB NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  subgroup_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  reviewer_decision VARCHAR(32) NOT NULL DEFAULT 'pending',
  rollback_target VARCHAR(128),
  limitations TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (task_type IN ('ranking', 'conversation_assistance', 'risk_scoring')),
  CHECK (status IN ('created', 'running', 'completed', 'failed', 'shadow')),
  CHECK (reviewer_decision IN ('pending', 'approved_shadow', 'approved_pilot', 'rejected'))
);

CREATE TABLE IF NOT EXISTS ai_shadow_decisions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  evaluation_run_id UUID REFERENCES ai_evaluation_runs(id) ON DELETE RESTRICT,
  task_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id UUID NOT NULL,
  model_version VARCHAR(128) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  output JSONB NOT NULL,
  confidence NUMERIC(8, 6),
  reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
  applied BOOLEAN NOT NULL DEFAULT false,
  human_review_status VARCHAR(32) NOT NULL DEFAULT 'not_reviewed',
  latency_ms INTEGER,
  cost_microunits BIGINT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (task_type IN ('ranking', 'conversation_assistance', 'risk_scoring')),
  CHECK (entity_type IN ('expert_profile', 'engagement', 'payment_stream', 'conversation')),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (human_review_status IN ('not_reviewed', 'accepted', 'edited', 'rejected')),
  CHECK (applied = false OR human_review_status IN ('accepted', 'edited'))
);

CREATE INDEX IF NOT EXISTS ai_shadow_decisions_entity_index
  ON ai_shadow_decisions (task_type, entity_type, entity_id, created_at DESC);
