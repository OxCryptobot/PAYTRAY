import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { claimWebhookInbox } from '../lib/webhookInboxService.js'

const { Pool } = pg

function boundedInteger(name, fallback, min, max) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function summarizeDurations(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const percentileIndex = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))
  return {
    samples: sorted.length,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    meanMs: sorted.length === 0 ? 0 : Number((sorted.reduce((total, value) => total + value, 0) / sorted.length).toFixed(3)),
    p95Ms: sorted[percentileIndex] ?? 0
  }
}

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

let databaseIsolation = false

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

async function runRace(pool, input, attempts) {
  return Promise.all(Array.from({ length: attempts }, () => runTransaction(pool, input)))
}

function assertFirstClaimRace(outcomes, attempts) {
  const winners = outcomes.filter((result) => result.claimed && !result.duplicate)
  const activeDuplicates = outcomes.filter((result) => !result.claimed && result.duplicate && result.reason === 'lease_active')
  if (winners.length !== 1) throw new Error(`first-claim race produced ${winners.length} primary claims; expected exactly one`)
  if (activeDuplicates.length !== attempts - 1) throw new Error(`first-claim race produced ${activeDuplicates.length} lease-active duplicates; expected ${attempts - 1}`)
  outcomes.forEach((result, index) => assertSafety(result, `first-claim outcome ${index}`))
  return { attempts, winners: winners.length, losers: activeDuplicates.length }
}

function assertReclaimRace(outcomes, attempts) {
  const reclaimers = outcomes.filter((result) => result.claimed && result.duplicate && result.mutation === 'inbox_reclaim')
  const activeDuplicates = outcomes.filter((result) => !result.claimed && result.duplicate && result.reason === 'lease_active')
  if (reclaimers.length !== 1) throw new Error(`reclaim race produced ${reclaimers.length} reclaims; expected exactly one`)
  if (activeDuplicates.length !== attempts - 1) throw new Error(`reclaim race produced ${activeDuplicates.length} lease-active duplicates; expected ${attempts - 1}`)
  outcomes.forEach((result, index) => assertSafety(result, `reclaim outcome ${index}`))
  return { attempts, winners: reclaimers.length, losers: activeDuplicates.length }
}

async function runScenario(pool, attempts, repetition) {
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
    const firstClaimStartedAt = Date.now()
    const firstClaimOutcomes = await runRace(pool, input, attempts)
    const firstClaim = { ...assertFirstClaimRace(firstClaimOutcomes, attempts), elapsedMs: Date.now() - firstClaimStartedAt }

    const expiredAt = new Date(now.getTime() - 1)
    await pool.query(`
      UPDATE webhook_inbox
      SET status = 'retryable', lease_until = $2, next_attempt_at = $3, attempts = 1, last_error = 'disposable expired lease', updated_at = $3
      WHERE replay_key = $1
    `, [replayKey, expiredAt.toISOString(), expiredAt.toISOString()])

    const reclaimStartedAt = Date.now()
    const reclaimOutcomes = await runRace(pool, input, attempts)
    const reclaim = { ...assertReclaimRace(reclaimOutcomes, attempts), elapsedMs: Date.now() - reclaimStartedAt }

    const final = await pool.query('SELECT replay_key, status, attempts, body_sha256, event_type, payload FROM webhook_inbox WHERE replay_key = $1', [replayKey])
    if (!final.rows[0]) throw new Error('webhook inbox fixture was not persisted')
    const state = final.rows[0]
    if (state.status !== 'claimed' || Number(state.attempts) !== 2) throw new Error('webhook inbox final state is not claimed with exactly two attempts')
    if (state.body_sha256 !== bodySha256 || state.event_type !== eventType) throw new Error('webhook inbox durable identity does not match the signed payload')
    if (state.payload?.applied !== false) throw new Error('webhook inbox payload must remain non-applied')

    let conflictRejected = false
    try {
      await runTransaction(pool, { ...input, body: `${body}!` })
    } catch (error) {
      conflictRejected = error.message === 'Webhook replay key conflicts with a different signed payload'
    }
    if (!conflictRejected) throw new Error('body-hash conflict was not rejected')

    await pool.query(`UPDATE webhook_inbox SET status = 'processed', processed_at = $2, lease_until = NULL, updated_at = $2 WHERE replay_key = $1`, [replayKey, now.toISOString()])
    const processedDuplicate = await runTransaction(pool, input)
    if (processedDuplicate.claimed !== false || processedDuplicate.reason !== 'processed' || processedDuplicate.mutation !== 'read_only') throw new Error('processed webhook duplicate did not remain read-only')
    assertSafety(processedDuplicate, 'processed duplicate')

    return {
      status: 'passed',
      repetition,
      firstClaim,
      reclaim,
      conflictRejected,
      processedDuplicate: { claimed: processedDuplicate.claimed, duplicate: processedDuplicate.duplicate, reason: processedDuplicate.reason, mutation: processedDuplicate.mutation },
      finalState: { status: state.status, attempts: Number(state.attempts), bodySha256, eventType, payloadApplied: state.payload?.applied === true }
    }
  } finally {
    await pool.query('DELETE FROM webhook_inbox WHERE replay_key = $1', [replayKey]).catch(() => {})
  }
}

async function main() {
  const connectionString = requireIsolation()
  databaseIsolation = true
  const attempts = boundedInteger('MIGRATION_016_CONCURRENCY_ATTEMPTS', 8, 2, 16)
  const repetitions = boundedInteger('MIGRATION_016_CONCURRENCY_REPETITIONS', 3, 1, 10)
  const pool = new Pool({ connectionString, max: attempts + 2, connectionTimeoutMillis: 5000 })
  try {
    const runs = []
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      runs.push(await runScenario(pool, attempts, repetition))
    }
    console.log(JSON.stringify({
      status: 'verified',
      migration: '016_webhook_inbox',
      concurrency: {
        attempts,
        repetitions,
        totalAttempts: attempts * repetitions,
        validRuns: runs.length,
        performance: {
          firstClaim: summarizeDurations(runs.map((run) => run.firstClaim.elapsedMs)),
          reclaim: summarizeDurations(runs.map((run) => run.reclaim.elapsedMs))
        }
      },
      runs,
      databaseIsolation,
      cleanupPerformed: true,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
  } finally {
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
    databaseIsolation,
    cleanupPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
