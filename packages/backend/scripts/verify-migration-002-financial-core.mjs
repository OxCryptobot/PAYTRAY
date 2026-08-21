import assert from 'node:assert/strict'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const MIGRATION = '002_financial_core'
const DATABASE_URL = process.env.MIGRATION_002_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_002_CONTRACT_ISOLATED === 'true'
const CHAIN_ID = 84532
const TOKEN_ADDRESS = '0x0000000000000000000000000000000000000001'
const PROTOCOL_ADDRESS = '0x0000000000000000000000000000000000000002'

function json(value) { return JSON.stringify(value, null, 2) }

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_002_CONTRACT_DATABASE_URL or DATABASE_URL is required')
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('database URL must be a valid URL') }
  const databaseName = parsed.pathname.replace(/^\//, '')
  const safeHost = ['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.hostname.endsWith('.test')
  const safeName = /(?:^|[_-])(ci|test|testing|disposable)(?:$|[_-])/i.test(databaseName)
  if (!safeHost || !safeName) throw new Error('database target must be a local/test/disposable PostgreSQL database; refusing non-disposable target')
}

async function withTransaction(pool, callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function expectSqlState(pool, name, expectedSqlState, callback) {
  let error = null
  try {
    await withTransaction(pool, callback)
    assert.fail(`${name}: expected PostgreSQL SQLSTATE ${expectedSqlState}`)
  } catch (caught) {
    error = caught
  }
  assert.equal(error?.code, expectedSqlState, `${name}: unexpected SQLSTATE or assertion failure: ${error?.message}`)
  return { status: 'passed', sqlState: expectedSqlState }
}

async function verifyCatalog(client) {
  const tables = await client.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name = ANY($1::text[])
     ORDER BY table_name
  `, [[
    'engagements', 'payment_intents', 'payment_chain_events', 'ledger_accounts',
    'ledger_entries', 'idempotency_records', 'outbox_events', 'financial_audit_events'
  ]])
  assert.deepEqual(tables.rows.map((row) => row.table_name), [
    'engagements', 'financial_audit_events', 'idempotency_records', 'ledger_accounts',
    'ledger_entries', 'outbox_events', 'payment_chain_events', 'payment_intents'
  ])

  const streamColumns = await client.query(`
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payment_streams'
       AND column_name = ANY($1::text[])
     ORDER BY column_name
  `, [[
    'engagement_id', 'lifecycle_state', 'finality_status', 'source', 'protocol_name',
    'protocol_version', 'protocol_contract_address', 'protocol_stream_id', 'chain_id',
    'token_address', 'token_decimals', 'amount_base_units', 'version', 'correlation_id',
    'lifecycle_updated_at'
  ]])
  assert.equal(streamColumns.rows.length, 15)

  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname = ANY($1::text[])
     ORDER BY indexname
  `, [[
    'payment_streams_protocol_identity_unique', 'payment_streams_engagement_index',
    'payment_intents_stream_index', 'payment_chain_events_stream_index',
    'ledger_entries_event_type_unique', 'idempotency_records_expiry_index',
    'outbox_events_pending_index', 'financial_audit_events_entity_index'
  ]])
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'financial_audit_events_entity_index',
    'idempotency_records_expiry_index',
    'ledger_entries_event_type_unique',
    'outbox_events_pending_index',
    'payment_chain_events_stream_index',
    'payment_intents_stream_index',
    'payment_streams_engagement_index',
    'payment_streams_protocol_identity_unique'
  ])

  const protocolIndex = await client.query(`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'payment_streams_protocol_identity_unique'
  `)
  assert.match(protocolIndex.rows[0].indexdef, /UNIQUE INDEX/i)
  assert.match(protocolIndex.rows[0].indexdef, /chain_id/i)
  assert.match(protocolIndex.rows[0].indexdef, /protocol_contract_address/i)
  assert.match(protocolIndex.rows[0].indexdef, /protocol_stream_id/i)
  assert.match(protocolIndex.rows[0].indexdef, /WHERE \(protocol_stream_id IS NOT NULL\)/i)

  const uniqueDefinitions = await client.query(`
    SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND contype = 'u'
       AND conrelid::regclass::text IN ('engagements', 'payment_intents', 'payment_chain_events', 'ledger_accounts', 'idempotency_records')
     ORDER BY table_name, definition
  `)
  assert.ok(uniqueDefinitions.rows.some((row) => row.table_name === 'payment_intents' && /sender_id/i.test(row.definition) && /idempotency_key/i.test(row.definition)))
  assert.ok(uniqueDefinitions.rows.some((row) => row.table_name === 'payment_intents' && /transaction_hash/i.test(row.definition)))
  assert.ok(uniqueDefinitions.rows.some((row) => row.table_name === 'payment_chain_events' && /chain_id/i.test(row.definition) && /transaction_hash/i.test(row.definition) && /log_index/i.test(row.definition)))
  assert.ok(uniqueDefinitions.rows.some((row) => row.table_name === 'ledger_accounts' && /owner_user_id/i.test(row.definition) && /account_type/i.test(row.definition)))
  assert.ok(uniqueDefinitions.rows.some((row) => row.table_name === 'idempotency_records' && /scope/i.test(row.definition) && /idempotency_key/i.test(row.definition)))

  const checks = await client.query(`
    SELECT conrelid::regclass::text AS table_name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE connamespace = 'public'::regnamespace AND contype = 'c'
       AND conrelid::regclass::text IN ('engagements', 'payment_intents', 'payment_chain_events', 'ledger_accounts', 'ledger_entries', 'outbox_events', 'financial_audit_events')
     ORDER BY table_name, conname
  `)
  const definitions = checks.rows.map((row) => row.definition).join('\n')
  for (const pattern of [
    /client_id.*provider_id/i,
    /intent_type/i,
    /token_decimals/i,
    /confirmation_count/i,
    /finality_status/i,
    /account_type/i,
    /debit_account_id.*credit_account_id/i,
    /amount_base_units/i,
    /source_chain_event_id.*source_intent_id/is,
    /attempts/i,
    /actor_type/i
  ]) assert.match(definitions, pattern)

  return {
    status: 'passed',
    tables: tables.rows.map((row) => row.table_name),
    paymentStreamColumns: streamColumns.rows.length,
    indexes: indexes.rows.map((row) => row.indexname),
    uniqueBoundaries: 5,
    checkConstraintCount: checks.rows.length
  }
}

async function createFixture(client, suffix) {
  const users = await client.query(`
    INSERT INTO users (wallet_address) VALUES ($1), ($2) RETURNING id
  `, [`migration002-client-${suffix}`, `migration002-provider-${suffix}`])
  const engagement = await client.query(`
    INSERT INTO engagements (client_id, provider_id, status, scope)
    VALUES ($1, $2, 'active', 'bounded financial-core verifier engagement')
    RETURNING id
  `, [users.rows[0].id, users.rows[1].id])
  const stream = await client.query(`
    INSERT INTO payment_streams (
      sender_id, recipient_id, token_symbol, amount, duration_seconds, status,
      engagement_id, lifecycle_state, finality_status, source, protocol_name,
      protocol_version, protocol_contract_address, protocol_stream_id, chain_id,
      token_address, token_decimals, amount_base_units
    ) VALUES ($1, $2, 'USDC', 1.00, 60, 'active', $3, 'active', 'unverified',
      'protocol', 'Sablier Flow', 'v3', $4, $5, $6, $7, 6, 1000000)
    RETURNING id
  `, [users.rows[0].id, users.rows[1].id, engagement.rows[0].id, PROTOCOL_ADDRESS, `migration002-stream-${suffix}`, CHAIN_ID, TOKEN_ADDRESS])
  const intent = await client.query(`
    INSERT INTO payment_intents (
      engagement_id, sender_id, recipient_id, intent_type, stream_id, chain_id,
      token_address, token_decimals, amount_base_units, rate_per_second_base_units,
      idempotency_key, request_hash, status
    ) VALUES ($1, $2, $3, 'create_stream', $4, $5, $6, 6, 1000000, 16666, $7, $8, 'intent_created')
    RETURNING id
  `, [engagement.rows[0].id, users.rows[0].id, users.rows[1].id, stream.rows[0].id, CHAIN_ID, TOKEN_ADDRESS, `migration002-intent-${suffix}`, 'a'.repeat(64)])
  const accounts = await client.query(`
    INSERT INTO ledger_accounts (owner_user_id, chain_id, token_address, account_type)
    VALUES ($1, $3, $4, 'client_escrow'), ($2, $3, $4, 'provider_available')
    RETURNING id, account_type
  `, [users.rows[0].id, users.rows[1].id, CHAIN_ID, TOKEN_ADDRESS])
  return {
    userIds: users.rows.map((row) => row.id),
    engagementId: engagement.rows[0].id,
    streamId: stream.rows[0].id,
    intentId: intent.rows[0].id,
    intentKey: `migration002-intent-${suffix}`,
    protocolStreamId: `migration002-stream-${suffix}`,
    accountIds: accounts.rows.map((row) => row.id),
    accountTypes: accounts.rows.map((row) => row.account_type)
  }
}

async function insertPaymentIntent(client, fixture, suffix, overrides = {}) {
  const values = {
    senderId: fixture.userIds[0],
    recipientId: fixture.userIds[1],
    intentType: 'create_stream',
    streamId: fixture.streamId,
    chainId: CHAIN_ID,
    tokenAddress: TOKEN_ADDRESS,
    tokenDecimals: 6,
    amountBaseUnits: '1000000',
    ratePerSecondBaseUnits: '16666',
    idempotencyKey: `migration002-intent-${suffix}`,
    requestHash: 'b'.repeat(64),
    transactionHash: null,
    status: 'intent_created'
  }
  Object.assign(values, overrides)
  return client.query(`
    INSERT INTO payment_intents (
      sender_id, recipient_id, intent_type, stream_id, chain_id, token_address,
      token_decimals, amount_base_units, rate_per_second_base_units,
      idempotency_key, request_hash, transaction_hash, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id, idempotency_key, transaction_hash, status
  `, [values.senderId, values.recipientId, values.intentType, values.streamId, values.chainId, values.tokenAddress, values.tokenDecimals, values.amountBaseUnits, values.ratePerSecondBaseUnits, values.idempotencyKey, values.requestHash, values.transactionHash, values.status])
}

async function insertChainEvent(client, fixture, suffix, overrides = {}) {
  const values = {
    streamId: fixture.streamId,
    intentId: fixture.intentId,
    chainId: CHAIN_ID,
    protocolContractAddress: PROTOCOL_ADDRESS,
    transactionHash: `0x${suffix.padStart(64, '0').slice(-64)}`,
    blockNumber: 100,
    blockHash: `0x${'1'.repeat(64)}`,
    logIndex: 0,
    eventName: 'CreateFlowStream',
    confirmationCount: 0,
    finalityStatus: 'observed',
    eventPayload: JSON.stringify({ source: 'migration-002-verifier' }),
    eventPayloadHash: 'c'.repeat(64)
  }
  Object.assign(values, overrides)
  return client.query(`
    INSERT INTO payment_chain_events (
      stream_id, intent_id, chain_id, protocol_contract_address, transaction_hash,
      block_number, block_hash, log_index, event_name, event_payload,
      event_payload_hash, confirmation_count, finality_status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
    RETURNING id, transaction_hash, log_index, finality_status
  `, [values.streamId, values.intentId, values.chainId, values.protocolContractAddress, values.transactionHash, values.blockNumber, values.blockHash, values.logIndex, values.eventName, values.eventPayload, values.eventPayloadHash, values.confirmationCount, values.finalityStatus])
}

async function insertLedgerEntry(client, fixture, overrides = {}) {
  const values = {
    sourceChainEventId: fixture.chainEventId,
    sourceIntentId: null,
    debitAccountId: fixture.accountIds[0],
    creditAccountId: fixture.accountIds[1],
    entryType: 'stream_funding',
    amountBaseUnits: '1000000',
    chainId: CHAIN_ID,
    tokenAddress: TOKEN_ADDRESS
  }
  Object.assign(values, overrides)
  return client.query(`
    INSERT INTO ledger_entries (
      source_chain_event_id, source_intent_id, debit_account_id, credit_account_id,
      entry_type, amount_base_units, chain_id, token_address
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, source_chain_event_id, source_intent_id, entry_type, amount_base_units
  `, [values.sourceChainEventId, values.sourceIntentId, values.debitAccountId, values.creditAccountId, values.entryType, values.amountBaseUnits, values.chainId, values.tokenAddress])
}

async function insertIdempotencyRecord(client, suffix, overrides = {}) {
  const values = {
    scope: 'migration-002-verifier',
    idempotencyKey: `record-${suffix}`,
    requestHash: 'd'.repeat(64),
    resourceType: 'payment_intent',
    resourceId: null,
    responsePayload: JSON.stringify({ status: 'accepted' }),
    statusCode: 201,
    expiresAt: '2026-09-20T00:00:00.000Z'
  }
  Object.assign(values, overrides)
  return client.query(`
    INSERT INTO idempotency_records (
      scope, idempotency_key, request_hash, resource_type, resource_id,
      response_payload, status_code, expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
    RETURNING id, scope, idempotency_key
  `, [values.scope, values.idempotencyKey, values.requestHash, values.resourceType, values.resourceId, values.responsePayload, values.statusCode, values.expiresAt])
}

async function insertOutboxEvent(client, fixture, suffix, overrides = {}) {
  const values = {
    aggregateType: 'payment_intent',
    aggregateId: fixture.intentId,
    eventType: `migration-002-${suffix}`,
    payload: JSON.stringify({ source: 'migration-002-verifier' }),
    attempts: 0
  }
  Object.assign(values, overrides)
  return client.query(`
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, attempts)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    RETURNING id, attempts, processed_at
  `, [values.aggregateType, values.aggregateId, values.eventType, values.payload, values.attempts])
}

async function paymentIntentRace(pool, fixture, key, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertPaymentIntent(client, fixture, `race-${key}`))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  return assertUniqueRace(outcomes, attempts, 'payment-intent idempotency')
}

async function chainEventRace(pool, fixture, key, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertChainEvent(client, fixture, `race-${key}`))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  return assertUniqueRace(outcomes, attempts, 'chain-event identity')
}

async function ledgerEventRace(pool, fixture, key, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertLedgerEntry(client, fixture, { entryType: `race-${key}` }))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  return assertUniqueRace(outcomes, attempts, 'ledger event and entry type')
}

async function idempotencyRecordRace(pool, key, attempts) {
  const outcomes = await Promise.all(Array.from({ length: attempts }, async () => {
    try {
      await withTransaction(pool, (client) => insertIdempotencyRecord(client, `race-${key}`))
      return { status: 'committed' }
    } catch (error) {
      return { status: 'rejected', sqlState: error.code || null }
    }
  }))
  return assertUniqueRace(outcomes, attempts, 'idempotency record')
}

function assertUniqueRace(outcomes, attempts, label) {
  const winners = outcomes.filter((outcome) => outcome.status === 'committed')
  const losers = outcomes.filter((outcome) => outcome.status === 'rejected')
  assert.equal(winners.length, 1, `exactly one ${label} writer must commit`)
  assert.equal(losers.length, attempts - 1, `all remaining ${label} writers must reject`)
  assert.ok(losers.every((outcome) => outcome.sqlState === '23505'), `every ${label} loser must return SQLSTATE 23505`)
  return { status: 'passed', attempts, winners: winners.length, losers: losers.length, sqlStateCounts: { '23505': losers.length } }
}

async function runContractSuite(pool, attempts, repetitions) {
  const userIds = []
  const engagementIds = []
  const streamIds = []
  const intentIds = []
  const chainEventIds = []
  const accountIds = []
  const ledgerEntryIds = []
  const idempotencyIds = []
  const outboxIds = []
  const auditIds = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const fixture = await withTransaction(pool, (client) => createFixture(client, `${Date.now()}-${Math.random().toString(16).slice(2)}`))
    userIds.push(...fixture.userIds)
    engagementIds.push(fixture.engagementId)
    streamIds.push(fixture.streamId)
    intentIds.push(fixture.intentId)
    accountIds.push(...fixture.accountIds)

    const chainEvent = await withTransaction(pool, (client) => insertChainEvent(client, fixture, `base-${Date.now()}`))
    fixture.chainEventId = chainEvent.rows[0].id
    chainEventIds.push(fixture.chainEventId)
    const ledgerEntry = await withTransaction(pool, (client) => insertLedgerEntry(client, fixture))
    ledgerEntryIds.push(ledgerEntry.rows[0].id)
    const baseIdempotencyKey = `base-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const idempotencyRecord = await withTransaction(pool, (client) => insertIdempotencyRecord(client, baseIdempotencyKey, { resourceId: fixture.intentId }))
    idempotencyIds.push(idempotencyRecord.rows[0].id)
    const outbox = await withTransaction(pool, (client) => insertOutboxEvent(client, fixture, `base-${Date.now()}`))
    outboxIds.push(outbox.rows[0].id)
    const audit = await withTransaction(pool, (client) => client.query(`
      INSERT INTO financial_audit_events (actor_type, actor_id, action, entity_type, entity_id, metadata)
      VALUES ('verifier', 'migration-002', 'contract_check', 'payment_intent', $1, '{}'::jsonb)
      RETURNING id, metadata
    `, [fixture.intentId]))
    auditIds.push(audit.rows[0].id)
    assert.deepEqual(audit.rows[0].metadata, {})

    const duplicateIntent = await expectSqlState(pool, 'duplicate sender and idempotency key', '23505', (client) => insertPaymentIntent(client, fixture, `duplicate-${Date.now()}`, { idempotencyKey: fixture.intentKey }))
    const differentIntent = await withTransaction(pool, (client) => insertPaymentIntent(client, fixture, `different-${Date.now()}`, { idempotencyKey: `migration002-different-${Date.now()}` }))
    intentIds.push(differentIntent.rows[0].id)
    const transactionHash = '0x' + 'f'.repeat(64)
    const transactionSeed = await withTransaction(pool, (client) => insertPaymentIntent(client, fixture, `transaction-seed-${Date.now()}`, { idempotencyKey: `migration002-transaction-seed-${Date.now()}`, transactionHash }))
    intentIds.push(transactionSeed.rows[0].id)
    const duplicateTransactionHash = await expectSqlState(pool, 'duplicate transaction hash', '23505', (client) => insertPaymentIntent(client, fixture, `transaction-duplicate-${Date.now()}`, { idempotencyKey: `migration002-transaction-duplicate-${Date.now()}`, transactionHash }))

    const sameEngagementUsers = await expectSqlState(pool, 'engagement with identical participants', '23514', (client) => client.query(`
      INSERT INTO engagements (client_id, provider_id, status) VALUES ($1, $1, 'draft')
    `, [fixture.userIds[0]]))
    const invalidEngagementStatus = await expectSqlState(pool, 'invalid engagement status', '23514', (client) => client.query(`
      INSERT INTO engagements (client_id, provider_id, status) VALUES ($1, $2, 'unknown')
    `, fixture.userIds))
    const sameIntentUsers = await expectSqlState(pool, 'payment intent with identical participants', '23514', (client) => insertPaymentIntent(client, fixture, `same-users-${Date.now()}`, { senderId: fixture.userIds[0], recipientId: fixture.userIds[0], idempotencyKey: `migration002-same-users-${Date.now()}` }))
    const invalidTokenDecimals = await expectSqlState(pool, 'payment intent token decimals above 255', '23514', (client) => insertPaymentIntent(client, fixture, `decimals-${Date.now()}`, { idempotencyKey: `migration002-decimals-${Date.now()}`, tokenDecimals: 256 }))
    const negativeAmount = await expectSqlState(pool, 'negative payment intent amount', '23514', (client) => insertPaymentIntent(client, fixture, `negative-${Date.now()}`, { idempotencyKey: `migration002-negative-${Date.now()}`, amountBaseUnits: -1 }))

    const duplicateProtocolStream = await expectSqlState(pool, 'duplicate protocol stream identity', '23505', (client) => client.query(`
      INSERT INTO payment_streams (sender_id, recipient_id, token_symbol, amount, duration_seconds, engagement_id, protocol_contract_address, protocol_stream_id, chain_id, token_address, token_decimals, amount_base_units)
      VALUES ($1, $2, 'USDC', 1, 60, $3, $4, $5, $6, $7, 6, 1000000)
    `, [fixture.userIds[0], fixture.userIds[1], fixture.engagementId, PROTOCOL_ADDRESS, fixture.protocolStreamId, CHAIN_ID, TOKEN_ADDRESS]))
    const negativeConfirmation = await expectSqlState(pool, 'negative chain-event confirmation count', '23514', (client) => insertChainEvent(client, fixture, `negative-confirmation-${Date.now()}`, { confirmationCount: -1 }))
    const invalidFinality = await expectSqlState(pool, 'invalid chain-event finality status', '23514', (client) => insertChainEvent(client, fixture, `invalid-finality-${Date.now()}`, { finalityStatus: 'unknown' }))
    const duplicateChainIdentity = await expectSqlState(pool, 'duplicate chain-event identity', '23505', (client) => insertChainEvent(client, fixture, `duplicate-chain-${Date.now()}`, { transactionHash: chainEvent.rows[0].transaction_hash, logIndex: chainEvent.rows[0].log_index }))

    const sameLedgerAccounts = await expectSqlState(pool, 'ledger debit and credit account equality', '23514', (client) => insertLedgerEntry(client, fixture, { debitAccountId: fixture.accountIds[0], creditAccountId: fixture.accountIds[0], entryType: `same-account-${Date.now()}` }))
    const zeroLedgerAmount = await expectSqlState(pool, 'zero ledger amount', '23514', (client) => insertLedgerEntry(client, fixture, { amountBaseUnits: 0, entryType: `zero-amount-${Date.now()}` }))
    const missingLedgerProvenance = await expectSqlState(pool, 'missing ledger provenance', '23514', (client) => insertLedgerEntry(client, fixture, { sourceChainEventId: null, sourceIntentId: null, entryType: `missing-provenance-${Date.now()}` }))
    const duplicateLedgerEventType = await expectSqlState(pool, 'duplicate ledger event and entry type', '23505', (client) => insertLedgerEntry(client, fixture, { entryType: ledgerEntry.rows[0].entry_type }))
    const duplicateLedgerAccount = await expectSqlState(pool, 'duplicate ledger account identity', '23505', (client) => client.query(`
      INSERT INTO ledger_accounts (owner_user_id, chain_id, token_address, account_type) VALUES ($1, $2, $3, 'client_escrow')
    `, [fixture.userIds[0], CHAIN_ID, TOKEN_ADDRESS]))
    const duplicateIdempotency = await expectSqlState(pool, 'duplicate idempotency record', '23505', (client) => insertIdempotencyRecord(client, baseIdempotencyKey, { resourceId: fixture.intentId }))
    const negativeOutboxAttempts = await expectSqlState(pool, 'negative outbox attempts', '23514', (client) => insertOutboxEvent(client, fixture, `negative-attempts-${Date.now()}`, { attempts: -1 }))
    const invalidAuditActor = await expectSqlState(pool, 'invalid financial audit actor type', '23514', (client) => client.query(`
      INSERT INTO financial_audit_events (actor_type, action, entity_type, metadata) VALUES ('unknown', 'contract_check', 'payment_intent', '{}'::jsonb)
    `))

    const paymentIntentRaces = []
    const chainEventRaces = []
    const ledgerEntryRaces = []
    const idempotencyRaces = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      const key = `${Date.now()}-${repetition}-${Math.random().toString(16).slice(2)}`
      paymentIntentRaces.push(await paymentIntentRace(pool, fixture, key, attempts))
      const raceEvent = await withTransaction(pool, (client) => insertChainEvent(client, fixture, `race-source-${key}`))
      fixture.chainEventId = raceEvent.rows[0].id
      chainEventIds.push(fixture.chainEventId)
      chainEventRaces.push(await chainEventRace(pool, fixture, key, attempts))
      ledgerEntryRaces.push(await ledgerEventRace(pool, fixture, key, attempts))
      idempotencyRaces.push(await idempotencyRecordRace(pool, key, attempts))
    }

    return {
      status: 'verified',
      cases: {
        catalog,
        validRoundTrips: { status: 'passed', engagement: true, paymentStream: true, paymentIntent: true, chainEvent: true, ledgerEntry: true, idempotencyRecord: true, outboxEvent: true, financialAuditEvent: true },
        duplicateSenderIdempotency: duplicateIntent,
        differentIntent: { status: 'passed', id: differentIntent.rows[0].id },
        duplicateTransactionHash,
        sameEngagementUsers,
        invalidEngagementStatus,
        sameIntentUsers,
        invalidTokenDecimals,
        negativeAmount,
        duplicateProtocolStream,
        negativeConfirmation,
        invalidFinality,
        duplicateChainIdentity,
        sameLedgerAccounts,
        zeroLedgerAmount,
        missingLedgerProvenance,
        duplicateLedgerEventType,
        duplicateLedgerAccount,
        duplicateIdempotency,
        negativeOutboxAttempts,
        invalidAuditActor,
        concurrentPaymentIntentIdempotency: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: paymentIntentRaces },
        concurrentChainEventIdentity: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: chainEventRaces },
        concurrentLedgerEventType: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: ledgerEntryRaces },
        concurrentIdempotencyRecord: { status: 'verified', attempts, repetitions, totalAttempts: attempts * repetitions, runs: idempotencyRaces }
      },
      cleanupRows: { users: userIds.length, engagements: engagementIds.length, streams: streamIds.length, intents: intentIds.length, chainEvents: chainEventIds.length, accounts: accountIds.length, ledgerEntries: 'all fixture entries', idempotencyRecords: 'all verifier-scope records', outboxEvents: outboxIds.length, auditEvents: auditIds.length }
    }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query(`
        DELETE FROM ledger_entries
         WHERE id = ANY($1::uuid[])
            OR source_chain_event_id = ANY($2::uuid[])
            OR source_intent_id = ANY($3::uuid[])
            OR source_intent_id IN (
              SELECT id FROM payment_intents WHERE sender_id = ANY($4::uuid[]) OR recipient_id = ANY($4::uuid[])
            )
      `, [ledgerEntryIds, chainEventIds, intentIds, userIds])
      await client.query('DELETE FROM outbox_events WHERE id = ANY($1::uuid[])', [outboxIds])
      await client.query('DELETE FROM financial_audit_events WHERE id = ANY($1::uuid[])', [auditIds])
      await client.query("DELETE FROM idempotency_records WHERE scope = 'migration-002-verifier' OR id = ANY($1::uuid[])", [idempotencyIds])
      await client.query('DELETE FROM payment_chain_events WHERE id = ANY($1::uuid[])', [chainEventIds])
      await client.query('DELETE FROM payment_intents WHERE id = ANY($1::uuid[]) OR sender_id = ANY($2::uuid[]) OR recipient_id = ANY($2::uuid[])', [intentIds, userIds])
      await client.query('DELETE FROM payment_streams WHERE id = ANY($1::uuid[])', [streamIds])
      await client.query('DELETE FROM ledger_accounts WHERE id = ANY($1::uuid[])', [accountIds])
      await client.query('DELETE FROM engagements WHERE id = ANY($1::uuid[])', [engagementIds])
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_002_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const attempts = boundedInteger('MIGRATION_002_CONCURRENCY_ATTEMPTS', 4, 2, 16)
  const repetitions = boundedInteger('MIGRATION_002_CONCURRENCY_REPETITIONS', 2, 1, 10)
  const pool = new Pool({ connectionString: DATABASE_URL, max: attempts + 4, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool, attempts, repetitions)
    console.log(json({ ...report, migration: MIGRATION, databaseIsolation: true, cleanupPerformed: true, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: MIGRATION, databaseIsolation: true, cleanupPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
