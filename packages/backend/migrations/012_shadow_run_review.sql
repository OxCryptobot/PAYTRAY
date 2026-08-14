-- PayTray Batch E explicit human review of shadow evaluation runs

ALTER TABLE ai_evaluation_runs
  ADD COLUMN IF NOT EXISTS reviewer_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reviewer_notes TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS ai_evaluation_runs_review_index
  ON ai_evaluation_runs (reviewer_decision, reviewed_at DESC);
