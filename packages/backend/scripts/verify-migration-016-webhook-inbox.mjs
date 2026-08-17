import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { claimWebhookInbox } from '../lib/webhookInboxService.js'

const { Pool } = pg

function requireIsolation() {
  if (process.env.MIGRATION_016_CONTRACT_ISOLATED !== 'true') throw new Error('MIGRATION_016_CONTRACT_ISOLATED=true is required')
  const value = process.env.DATABASE_URL
  if (!value) throw new Error('DATABASE_URL is required')
  const url = new URL(value)
  const databaseName = url.pathname.replace(/^\//, '').toLowerCase()
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) || !/(ci|test|testing|disposable|recovery)/.test(databaseName)) {
    throw new Error('migration-016 verifier requires a local disposable database URL')
  }
  return value
}

function assertSafety(result, label) {
  if (result.settlementAuthority !== false) throw new Error(`${label} established settlement authority`)
  if (!['inbox_claim_only', 'inbox_reclaim', 'read_only'].includes(result.mutation)) throw new Error(`${label} returned unexpected mutation ${result.mutation}`)
}

async function runTransaction(pool, input) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await claimWebhookInbox({ client, ...input })
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function runRace(pool, input) {
  return Promise.all([runTransaction(pool, input), runTransaction(pool, input)])
}

async function main() {
  const connectionString = requireIsolation()
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 })
  const replayKey = `migration-016:${randomUUID()}`
  const eventType = 'ai.shadow_review_recorded'
  const body = JSON.stringify({ event: 'ai.shadow_review_recorded', runId: randomUUID() })
  const payload = { runId: randomUUID(), applied: false }
  const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex')
  const now = new Date('2026-08-17T00:00:00.000Z')
  const input = {
    replayKey,
    eventId: `event-${randomUUID()}`,
    hookId: `hook-${randomUUID()}`,
    eventType,
    body,
    payload,
    now,
    leaseMs: 120000
  }
  try {
    const firstClaimOutcomes = await runRace(pool, input)
    if (firstClaimOutcomes.filter((result) => result.claimed && !result.duplicate).length !== 1) throw new Error('first-claim race did not produce exactly one primary claim')
    if (firstClaimOutcomes.filter((result) => !result.claimed && result.duplicate && result.reason === 'lease_active').length !== 1) throw new Error('first-claim race did not produce exactly one active-lease duplicate')
    firstClaimOutcomes.forEach((result, index) => assertSafety(result, `first-claim outcome ${index}`))

    const expiredAt = new Date(now.getTime() - 1)
    await pool.query(`
      UPDATE webhook_inbox
      SET status = 'retryable', lease_until = $2, next_attempt_at = $3, attempts = 1, last_error = 'disposable expired lease', updated_at = $3
      WHERE replay_key = $1
    `, [replayKey, expiredAt.toISOString(), expiredAt.toISOString()])

    const reclaimOutcomes = await runRace(pool, input)
    if (reclaimOutcomes.filter((result) => result.claimed && result.duplicate && result.mutation === 'inbox_reclaim').length !== 1) throw new Error('reclaim race did not produce exactly one reclaim')
    if (reclaimOutcomes.filter((result) => !result.claimed && result.duplicate && result.reason === 'lease_active').length !== 1) throw new Error('reclaim race did not produce exactly one active-lease duplicate')
    reclaimOutcomes.forEach((result, index) => assertSafety(result, `reclaim outcome ${index}`))

    const final = await pool.query('SELECT replay_key, status, attempts, body_sha256, event_type, payload FROM webhook_inbox WHERE replay_key = $1', [replayKey])
    if (!final.rows[0]) throw new Error('webhook inbox fixture was not persisted')
    const state = final.rows[0]
    if (state.status !== 'claimed' || Number(state.attempts) !== 2) throw new Error('webhook inbox final state is not claimed with exactly two attempts')
    if (state.body_sha256 !== bodySha256 || state.event_type !== eventType) throw new Error('webhook inbox durable identity does not match the signed payload')
    if (state.payload?.applied !== false) throw new Error('webhook inbox payload must remain non-applied')

    console.log(JSON.stringify({
      status: 'verified',
      migration: '016_webhook_inbox',
      replayKey,
      firstClaimOutcomes: firstClaimOutcomes.map(({ claimed, duplicate, reason = null, mutation, settlementAuthority }) => ({ claimed, duplicate, reason, mutation, settlementAuthority })),
      reclaimOutcomes: reclaimOutcomes.map(({ claimed, duplicate, reason = null, mutation, settlementAuthority }) => ({ claimed, duplicate, reason, mutation, settlementAuthority })),
      finalState: { status: state.status, attempts: Number(state.attempts), bodySha256: state.body_sha256, eventType: state.event_type, payloadApplied: state.payload?.applied === true },
      databaseIsolation: true,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
  } finally {
    await pool.query('DELETE FROM webhook_inbox WHERE replay_key = $1', [replayKey]).catch(() => {})
    await pool.end()
  }
}

try {
  await main()
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    migration: '016_webhook_inbox',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
