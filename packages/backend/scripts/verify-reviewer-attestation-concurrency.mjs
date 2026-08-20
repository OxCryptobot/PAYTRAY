import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { Wallet } from 'ethers'
import { runMigrations } from '../lib/migrations.js'
import {
  buildReviewerAttestationMessage,
  issueReviewerAttestationChallenge,
  verifyReviewerAttestation
} from '../lib/reviewerAttestationService.js'

const { Pool } = pg
const DATABASE_URL = process.env.ATTESTATION_RACE_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.ATTESTATION_RACE_ISOLATED === 'true'
const REPETITIONS = Number.parseInt(process.env.ATTESTATION_RACE_REPETITIONS || '3', 10)

function assertRepetitions() {
  if (!Number.isInteger(REPETITIONS) || REPETITIONS < 1 || REPETITIONS > 10) {
    throw new Error('ATTESTATION_RACE_REPETITIONS must be an integer between 1 and 10')
  }
}

function json(value) {
  return JSON.stringify(value, null, 2)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('ATTESTATION_RACE_DATABASE_URL or DATABASE_URL is required')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('database URL must be a valid URL')
  }
  const databaseName = parsed.pathname.replace(/^\//, '')
  const safeHost = ['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.hostname.endsWith('.test')
  const safeName = /(?:^|[_-])(ci|test|testing|disposable)(?:$|[_-])/i.test(databaseName)
  if (!safeHost || !safeName) {
    throw new Error('database target must be a local/test/disposable PostgreSQL database; refusing non-disposable target')
  }
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

async function issueChallenge(pool, { wallet, releaseCommit, artifactSha256, publicKeyFingerprintSha256 }) {
  return withTransaction(pool, (client) => issueReviewerAttestationChallenge({
    client,
    reviewerWallet: wallet.address,
    role: 'security',
    releaseCommit,
    artifactSha256,
    publicKeyFingerprintSha256,
    decision: 'approved',
    ttlSeconds: 900
  }))
}

async function verifyWithHeldTransaction(client, { challengeId, signature, authenticatedWallet }) {
  await client.query('BEGIN')
  try {
    const result = await verifyReviewerAttestation({
      client,
      challengeId,
      signature,
      authenticatedWallet
    })
    await client.query('COMMIT')
    return { status: 'verified', commitPerformed: true, rollbackPerformed: false, result }
  } catch (error) {
    let rollbackPerformed = false
    try {
      await client.query('ROLLBACK')
      rollbackPerformed = true
    } catch {
      // The final database-state assertions still fail closed if rollback cannot be confirmed.
    }
    return {
      status: 'error',
      commitPerformed: false,
      rollbackPerformed,
      error: {
        name: error.name,
        message: error.message,
        code: error.code || null,
        statusCode: error.statusCode || null
      }
    }
  } finally {
    client.release()
  }
}

async function countRows(pool, challengeId, attestationId = null) {
  const attestation = await pool.query(
    'SELECT id, applied, release_eligible, settlement_authority, mutation, deployment_performed, settlement_mutation_performed FROM reviewer_attestations WHERE challenge_id = $1',
    [challengeId]
  )
  const challenge = await pool.query(
    'SELECT consumed_at FROM reviewer_attestation_challenges WHERE id = $1',
    [challengeId]
  )
  const audit = attestationId
    ? await pool.query(
        `SELECT COUNT(*)::int AS count
           FROM financial_audit_events
          WHERE entity_type = 'reviewer_attestation'
            AND entity_id = $1`,
        [attestationId]
      )
    : { rows: [{ count: 0 }] }
  return {
    attestationRows: attestation.rows,
    challengeRows: challenge.rows,
    auditRows: audit.rows
  }
}

async function cleanup(pool, challengeId) {
  await withTransaction(pool, async (client) => {
    const attestations = await client.query(
      'SELECT id FROM reviewer_attestations WHERE challenge_id = $1',
      [challengeId]
    )
    for (const row of attestations.rows) {
      await client.query(
        `DELETE FROM financial_audit_events
          WHERE entity_type = 'reviewer_attestation'
            AND entity_id = $1`,
        [row.id]
      )
    }
    await client.query('DELETE FROM reviewer_attestations WHERE challenge_id = $1', [challengeId])
    await client.query('DELETE FROM reviewer_attestation_challenges WHERE id = $1', [challengeId])
  })
}

async function runRace(pool, repetition) {
  const wallet = Wallet.createRandom()
  const releaseCommit = sha256(`attestation-race:${Date.now()}:${repetition}`).slice(0, 40)
  const artifactSha256 = sha256(`artifact:${releaseCommit}`)
  const publicKeyFingerprintSha256 = sha256(`fingerprint:${releaseCommit}`)
  const challenge = await issueChallenge(pool, {
    wallet,
    releaseCommit,
    artifactSha256,
    publicKeyFingerprintSha256
  })
  const signature = await wallet.signMessage(challenge.message)

  try {
    const message = buildReviewerAttestationMessage({
      challengeId: challenge.challengeId,
      reviewerWallet: challenge.reviewerWallet,
      role: challenge.role,
      releaseCommit: challenge.releaseCommit,
      artifactSha256: challenge.artifactSha256,
      publicKeyFingerprintSha256: challenge.publicKeyFingerprintSha256,
      decision: challenge.decision,
      nonce: challenge.message.match(/Nonce: ([0-9a-f]{64})/)?.[1],
      issuedAt: challenge.issuedAt,
      expiresAt: challenge.expiresAt
    })
    assert.equal(message, challenge.message, 'locally reconstructed challenge message must match the issued message')

    const clients = await Promise.all([pool.connect(), pool.connect()])
    const [first, second] = await Promise.all([
      verifyWithHeldTransaction(clients[0], {
        challengeId: challenge.challengeId,
        signature,
        authenticatedWallet: wallet.address
      }),
      verifyWithHeldTransaction(clients[1], {
        challengeId: challenge.challengeId,
        signature,
        authenticatedWallet: wallet.address
      })
    ])
    const outcomes = [first, second]
    const verified = outcomes.filter((outcome) => outcome.status === 'verified')
    const rejected = outcomes.filter((outcome) => outcome.status === 'error')
    assert.equal(verified.length, 1, `exactly one transaction must verify: ${json(outcomes)}`)
    assert.equal(rejected.length, 1, `exactly one transaction must be rejected: ${json(outcomes)}`)
    assert.equal(rejected[0].rollbackPerformed, true, `losing transaction must roll back: ${json(outcomes)}`)
    assert.match(rejected[0].error.message, /already consumed|consumed concurrently/)

    const attestationId = verified[0].result.attestationId
    const counts = await countRows(pool, challenge.challengeId, attestationId)
    assert.equal(counts.attestationRows.length, 1)
    assert.equal(counts.challengeRows.length, 1)
    assert.ok(counts.challengeRows[0].consumed_at)
    assert.equal(counts.auditRows[0].count, 1)
    assert.deepEqual(counts.attestationRows[0], {
      id: attestationId,
      applied: false,
      release_eligible: false,
      settlement_authority: false,
      mutation: 'read_only',
      deployment_performed: false,
      settlement_mutation_performed: false
    })

    return {
      status: 'verified',
      challengeId: challenge.challengeId,
      releaseCommit,
      outcomes: outcomes.map((outcome) => outcome.status === 'verified'
        ? { status: outcome.status, commitPerformed: outcome.commitPerformed, rollbackPerformed: outcome.rollbackPerformed, attestationId: outcome.result.attestationId, role: outcome.result.role }
        : { status: outcome.status, commitPerformed: outcome.commitPerformed, rollbackPerformed: outcome.rollbackPerformed, error: outcome.error.message }),
      attestationCount: counts.attestationRows.length,
      consumedChallengeCount: counts.challengeRows.filter((row) => row.consumed_at).length,
      auditEventCount: counts.auditRows[0].count,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only'
    }
  } finally {
    await cleanup(pool, challenge.challengeId)
  }
}

async function main() {
  assertRepetitions()
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'ATTESTATION_RACE_ISOLATED=true is required', mutation: 'read_only', releaseEligible: false, settlementAuthority: false }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const reports = []
    for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
      reports.push(await runRace(pool, repetition))
    }
    const rollbackVerifiedCount = reports.filter((report) => report.outcomes.filter((outcome) => outcome.status === 'error' && outcome.rollbackPerformed).length === 1).length
    assert.equal(rollbackVerifiedCount, REPETITIONS, `every repetition must confirm losing-transaction rollback: ${json(reports)}`)
    console.log(json({
      ...reports[0],
      repetitions: REPETITIONS,
      rollbackVerifiedCount,
      rollbackVerified: rollbackVerifiedCount === REPETITIONS,
      runs: reports,
      databaseIsolation: true,
      cleanupPerformed: true,
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, databaseIsolation: true, cleanupPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

await main()
