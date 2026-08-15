-- PayTray Batch CK durable non-financial operations-quality run evidence

CREATE TABLE IF NOT EXISTS operations_quality_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL UNIQUE,
  strict_mode BOOLEAN NOT NULL DEFAULT false,
  status VARCHAR(32) NOT NULL,
  check_count INTEGER NOT NULL CHECK (check_count >= 0),
  passed_count INTEGER NOT NULL CHECK (passed_count >= 0),
  operator_blocker_count INTEGER NOT NULL CHECK (operator_blocker_count >= 0),
  unexpected_failure_count INTEGER NOT NULL CHECK (unexpected_failure_count >= 0),
  report JSONB NOT NULL,
  report_hash CHAR(64) NOT NULL CHECK (report_hash ~ '^[0-9a-f]{64}$'),
  started_at TIMESTAMP NOT NULL,
  completed_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('passed', 'operator_blocked', 'failed')),
  CHECK (passed_count + operator_blocker_count + unexpected_failure_count = check_count),
  CHECK ((report->>'releaseEligible') = 'false'),
  CHECK ((report->>'settlementAuthority') = 'false'),
  CHECK ((report->>'mutation') = 'read_only'),
  CHECK ((report->>'deploymentPerformed') = 'false'),
  CHECK ((report->>'settlementMutationPerformed') = 'false')
);

CREATE INDEX IF NOT EXISTS operations_quality_runs_created_index
  ON operations_quality_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS operations_quality_runs_status_index
  ON operations_quality_runs (status, created_at DESC);
