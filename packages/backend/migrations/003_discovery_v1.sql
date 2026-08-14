-- PayTray Phase 2 discovery v1 schema extensions

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS availability_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64),
  ADD COLUMN IF NOT EXISTS languages TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS verification_status VARCHAR(32) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS evidence_links JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS response_latency_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS completion_rate NUMERIC(6, 5) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS repeat_booking_rate NUMERIC(6, 5) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paid_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disputes_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS profiles_expertise_gin_idx ON profiles USING GIN (expertise);
CREATE INDEX IF NOT EXISTS profiles_languages_gin_idx ON profiles USING GIN (languages);
CREATE INDEX IF NOT EXISTS profiles_discovery_idx ON profiles (is_expert, availability_status, verification_status, hourly_rate);
CREATE INDEX IF NOT EXISTS profiles_outcome_idx ON profiles (completion_rate DESC, repeat_booking_rate DESC, paid_minutes DESC);
