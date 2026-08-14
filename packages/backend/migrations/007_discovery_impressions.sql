-- PayTray Phase 3 ranking evaluation coverage

CREATE TABLE IF NOT EXISTS discovery_impressions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  query_id VARCHAR(255) NOT NULL,
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  candidate_profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  engagement_id UUID REFERENCES engagements(id) ON DELETE SET NULL,
  rank_position INTEGER NOT NULL,
  baseline_score NUMERIC(8, 4) NOT NULL,
  ranking_version VARCHAR(64) NOT NULL,
  query_features JSONB NOT NULL DEFAULT '{}'::jsonb,
  match_explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  selected BOOLEAN NOT NULL DEFAULT false,
  observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  CHECK (rank_position > 0),
  CHECK (baseline_score >= 0 AND baseline_score <= 100),
  UNIQUE (query_id, candidate_profile_id)
);

CREATE INDEX IF NOT EXISTS discovery_impressions_query_index
  ON discovery_impressions (query_id, rank_position, observed_at);
CREATE INDEX IF NOT EXISTS discovery_impressions_profile_index
  ON discovery_impressions (candidate_profile_id, observed_at DESC);
