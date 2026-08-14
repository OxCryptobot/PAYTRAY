-- PayTray Phase 2 engagement context and collaboration handoff

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS discovery_context JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS ranking_explanation JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS proposed_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS collaboration_status VARCHAR(32) NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS payment_status VARCHAR(32) NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS context_version INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT engagements_collaboration_status_check CHECK (collaboration_status IN ('not_started', 'ready', 'active', 'degraded', 'completed')),
  ADD CONSTRAINT engagements_payment_status_check CHECK (payment_status IN ('not_requested', 'intent_created', 'wallet_submitted', 'chain_pending', 'chain_finalized', 'ledger_reflected', 'degraded'));

CREATE INDEX IF NOT EXISTS engagements_participant_status_index
  ON engagements (client_id, provider_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS engagements_thread_index
  ON engagements (thread_id, updated_at DESC);
