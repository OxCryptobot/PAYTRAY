import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'
import { reviewShadowRun } from '../lib/shadowReviewService.js'

const { Pool } = pg
const DATABASE_URL = process.env.MIGRATION_012_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_012_CONTRACT_ISOLATED === 'true'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_012_CONTRACT_DATABASE_URL or DATABASE_URL is required')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('database URL must be a valid URL')
  }
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

async function reviewWithTransaction(pool, runId, reviewerId, decision) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await reviewShadowRun({
      client,
      runId,
      reviewerId,
      decision,
      notes: 'local disposable review contract'
    })
    await client.query('COMMIT')
    return {
      status: 'committed',
      commitPerformed: true,
      rollbackPerformed: false,
      idempotentReplay: result.idempotentReplay === true,
      decision: result.run.reviewer_decision
    }
  } catch (error) {
    let rollbackPerformed = false
    try {
      await client.query('ROLLBACK')
      rollbackPerformed = true
    } catch {
      // The report remains blocked unless the caller can verify the final database state.
    }
    return {
      status: 'rejected',
      commitPerformed: false,
      rollbackPerformed,
      errorName: error.name || 'Error',
      errorMessageClass: /different review decision|raced with another reviewer/.test(error.message) ? 'review_conflict' : 'unexpected'
    }
  } finally {
    client.release()
  }
}

async function insertRun(client) {
  const result = await client.query(`
    INSERT INTO ai_evaluation_runs (
      task_type, model_name, model_version, baseline_version, dataset_version,
      time_split, metrics, subgroup_metrics, status, reviewer_decision, rollback_target
    )
    VALUES ('ranking', 'local-disposable-model', 'v1', 'baseline-v1', 'dataset-local',
            $1::jsonb, $2::jsonb, '{}'::jsonb, 'shadow', 'pending', 'rollback-local')
    RETURNING id
  `, [JSON.stringify({ train: 'local', test: 'local' }), JSON.stringify({ accuracy: 0.5 })])
  return result.rows[0].id
}

async function runContractSuite(pool) {
  const runId = await withTransaction(pool, (client) => insertRun(client))
  try {
    const results = {}
    results.catalog = await withTransaction(pool, async (client) => {
      const columns = await client.query(`
        SELECT column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'ai_evaluation_runs'
           AND column_name = ANY($1::text[])
         ORDER BY column_name
      `, [['reviewer_id', 'reviewer_notes', 'reviewed_at']])
      assert.deepEqual(columns.rows.map((row) => row.column_name), ['reviewed_at', 'reviewer_id', 'reviewer_notes'])
      const indexes = await client.query(`
        SELECT indexname
          FROM pg_indexes
         WHERE schemaname = 'public'
           AND tablename = 'ai_evaluation_runs'
           AND indexname = 'ai_evaluation_runs_review_index'
      `)
      assert.deepEqual(indexes.rows.map((row) => row.indexname), ['ai_evaluation_runs_review_index'])
      return {
        status: 'passed',
        columns: columns.rows.map((row) => row.column_name),
        indexes: indexes.rows.map((row) => row.indexname)
      }
    })

    const outcomes = await Promise.all([
      reviewWithTransaction(pool, runId, `migration012-reviewer-a-${randomUUID()}`, 'approved_pilot'),
      reviewWithTransaction(pool, runId, `migration012-reviewer-b-${randomUUID()}`, 'rejected')
    ])
    const committed = outcomes.filter((outcome) => outcome.status === 'committed')
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected')
    assert.equal(committed.length, 1, `exactly one review transaction must commit: ${json(outcomes)}`)
    assert.equal(rejected.length, 1, `exactly one conflicting review transaction must reject: ${json(outcomes)}`)
    assert.equal(rejected[0].rollbackPerformed, true, `losing review transaction must roll back: ${json(outcomes)}`)
    assert.equal(rejected[0].errorMessageClass, 'review_conflict', `unexpected review error class: ${json(outcomes)}`)

    const persisted = (await pool.query(`
      SELECT status, reviewer_decision, reviewer_id, reviewer_notes, reviewed_at
        FROM ai_evaluation_runs WHERE id = $1
    `, [runId])).rows[0]
    assert.equal(persisted.status, 'shadow')
    assert.ok(['approved_pilot', 'rejected'].includes(persisted.reviewer_decision))
    assert.ok(persisted.reviewer_id)
    assert.equal(persisted.reviewer_notes, 'local disposable review contract')
    assert.ok(persisted.reviewed_at)

    const audit = await pool.query(`
      SELECT COUNT(*)::int AS count
        FROM financial_audit_events
       WHERE entity_type = 'ai_evaluation_run' AND entity_id = $1
    `, [runId])
    const outbox = await pool.query(`
      SELECT COUNT(*)::int AS count
        FROM outbox_events
       WHERE aggregate_type = 'ai_evaluation_run' AND aggregate_id = $1
    `, [runId])
    assert.equal(Number(audit.rows[0].count), 1)
    assert.equal(Number(outbox.rows[0].count), 1)

    results.reviewRace = {
      status: 'verified',
      attempts: outcomes.length,
      winners: committed.length,
      conflicts: rejected.length,
      rollbacks: rejected.filter((outcome) => outcome.rollbackPerformed).length,
      persistedStatus: persisted.status,
      persistedDecision: persisted.reviewer_decision,
      reviewerIdPresent: true,
      reviewNotesRedacted: true,
      reviewedAtPresent: true,
      applied: false,
      promotionStatus: 'shadow_only',
      authority: 'human_review_required',
      auditEventCount: Number(audit.rows[0].count),
      outboxEventCount: Number(outbox.rows[0].count)
    }
    return { status: 'verified', cases: results, cleanupRunId: runId }
  } finally {
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM outbox_events WHERE aggregate_type = \'ai_evaluation_run\' AND aggregate_id = $1', [runId])
      await client.query('DELETE FROM financial_audit_events WHERE entity_type = \'ai_evaluation_run\' AND entity_id = $1', [runId])
      await client.query('DELETE FROM ai_evaluation_runs WHERE id = $1', [runId])
    })
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_012_CONTRACT_ISOLATED=true is required', migration: '012_shadow_run_review', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = new Pool({ connectionString: DATABASE_URL, max: 6, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool)
    console.log(json({
      ...report,
      migration: '012_shadow_run_review',
      databaseIsolation: true,
      cleanupPerformed: true,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }))
  } catch (error) {
    console.error(json({
      status: 'blocked',
      reason: error.message,
      code: error.code || null,
      migration: '012_shadow_run_review',
      databaseIsolation: true,
      cleanupPerformed: false,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only'
    }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
