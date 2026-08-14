-- PayTray durable financial core
-- This migration adds an auditable, event-derived payment model while retaining the
-- existing Phase 1 tables for backward-compatible migration.

CREATE TABLE IF NOT EXISTS engagements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  match_session_id VARCHAR(255),
  thread_id VARCHAR(255),
  status VARCHAR(32) NOT NULL DEFAULT 'draft',
  scope TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (client_id <> provider_id),
  CHECK (status IN ('draft', 'active', 'paused', 'completed', 'cancelled', 'disputed'))
);

ALTER TABLE payment_streams
  ADD COLUMN IF NOT EXISTS engagement_id UUID REFERENCES engagements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lifecycle_state VARCHAR(32) NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS finality_status VARCHAR(32) NOT NULL DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS protocol_name VARCHAR(64),
  ADD COLUMN IF NOT EXISTS protocol_version VARCHAR(64),
  ADD COLUMN IF NOT EXISTS protocol_contract_address VARCHAR(42),
  ADD COLUMN IF NOT EXISTS protocol_stream_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS chain_id BIGINT,
  ADD COLUMN IF NOT EXISTS token_address VARCHAR(42),
  ADD COLUMN IF NOT EXISTS token_decimals SMALLINT,
  ADD COLUMN IF NOT EXISTS amount_base_units NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS correlation_id UUID,
  ADD COLUMN IF NOT EXISTS lifecycle_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX IF NOT EXISTS payment_streams_protocol_identity_unique
  ON payment_streams (chain_id, protocol_contract_address, protocol_stream_id)
  WHERE protocol_stream_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payment_streams_engagement_index
  ON payment_streams (engagement_id, lifecycle_state, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_intents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  engagement_id UUID REFERENCES engagements(id) ON DELETE SET NULL,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  intent_type VARCHAR(32) NOT NULL,
  stream_id UUID REFERENCES payment_streams(id) ON DELETE SET NULL,
  chain_id BIGINT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  token_decimals SMALLINT NOT NULL,
  amount_base_units NUMERIC(78, 0),
  rate_per_second_base_units NUMERIC(78, 0),
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  transaction_hash VARCHAR(66),
  status VARCHAR(32) NOT NULL DEFAULT 'intent_created',
  correlation_id UUID NOT NULL DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (sender_id <> recipient_id),
  CHECK (intent_type IN ('create_stream', 'top_up', 'pause', 'restart', 'void', 'withdraw')),
  CHECK (status IN ('intent_created', 'wallet_submitted', 'chain_pending', 'failed', 'cancelled')),
  CHECK (token_decimals BETWEEN 0 AND 255),
  CHECK (amount_base_units IS NULL OR amount_base_units >= 0),
  CHECK (rate_per_second_base_units IS NULL OR rate_per_second_base_units >= 0),
  UNIQUE (sender_id, idempotency_key),
  UNIQUE (transaction_hash)
);

CREATE INDEX IF NOT EXISTS payment_intents_stream_index
  ON payment_intents (stream_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_chain_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  stream_id UUID REFERENCES payment_streams(id) ON DELETE SET NULL,
  intent_id UUID REFERENCES payment_intents(id) ON DELETE SET NULL,
  chain_id BIGINT NOT NULL,
  protocol_contract_address VARCHAR(42) NOT NULL,
  transaction_hash VARCHAR(66) NOT NULL,
  block_number BIGINT NOT NULL,
  block_hash VARCHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  event_name VARCHAR(128) NOT NULL,
  event_payload JSONB NOT NULL,
  event_payload_hash CHAR(64) NOT NULL,
  confirmation_count INTEGER NOT NULL DEFAULT 0,
  finality_status VARCHAR(32) NOT NULL DEFAULT 'observed',
  observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finalized_at TIMESTAMP,
  invalidated_at TIMESTAMP,
  correlation_id UUID,
  CHECK (confirmation_count >= 0),
  CHECK (finality_status IN ('observed', 'included', 'finalized', 'reorged', 'invalid')),
  UNIQUE (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS payment_chain_events_stream_index
  ON payment_chain_events (stream_id, finality_status, block_number DESC);

CREATE TABLE IF NOT EXISTS ledger_accounts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  chain_id BIGINT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (account_type IN ('client_escrow', 'provider_available', 'provider_withdrawn', 'platform_clearing', 'adjustment')),
  UNIQUE (owner_user_id, chain_id, token_address, account_type)
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_chain_event_id UUID REFERENCES payment_chain_events(id) ON DELETE RESTRICT,
  source_intent_id UUID REFERENCES payment_intents(id) ON DELETE RESTRICT,
  debit_account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  credit_account_id UUID NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  entry_type VARCHAR(64) NOT NULL,
  amount_base_units NUMERIC(78, 0) NOT NULL,
  chain_id BIGINT NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  correlation_id UUID NOT NULL DEFAULT uuid_generate_v4(),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (debit_account_id <> credit_account_id),
  CHECK (amount_base_units > 0),
  CHECK (source_chain_event_id IS NOT NULL OR source_intent_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_entries_event_type_unique
  ON ledger_entries (source_chain_event_id, entry_type)
  WHERE source_chain_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS idempotency_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  scope VARCHAR(128) NOT NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  resource_type VARCHAR(64) NOT NULL,
  resource_id UUID,
  response_payload JSONB,
  status_code INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  UNIQUE (scope, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idempotency_records_expiry_index
  ON idempotency_records (expires_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  correlation_id UUID NOT NULL DEFAULT uuid_generate_v4(),
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMP,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_index
  ON outbox_events (available_at, occurred_at)
  WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS financial_audit_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_type VARCHAR(32) NOT NULL,
  actor_id VARCHAR(255),
  action VARCHAR(128) NOT NULL,
  entity_type VARCHAR(64) NOT NULL,
  entity_id UUID,
  correlation_id UUID,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (actor_type IN ('user', 'wallet', 'verifier', 'ledger_worker', 'operator', 'system'))
);

CREATE INDEX IF NOT EXISTS financial_audit_events_entity_index
  ON financial_audit_events (entity_type, entity_id, created_at DESC);

