import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'

const { Pool } = pg
const DATABASE_URL = process.env.MIGRATION_019_CONTRACT_DATABASE_URL || process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_019_CONTRACT_ISOLATED === 'true'

function json(value) {
  return JSON.stringify(value, null, 2)
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertDisposableDatabaseUrl(value) {
  if (!value) throw new Error('MIGRATION_019_CONTRACT_DATABASE_URL or DATABASE_URL is required')
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

function makeFixture(seed) {
  const issuedAt = new Date('2026-08-16T00:00:00.000Z')
  const expiresAt = new Date('2026-08-16T00:15:00.000Z')
  const releaseCommit = sha256(`migration-019-contract:${seed}`).slice(0, 40)
  const artifactSha256 = sha256(`artifact:${seed}`)
  const publicKeyFingerprintSha256 = sha256(`fingerprint:${seed}`)
  const attestationDigest = sha256(`attestation:${seed}`)
  const messageHash = sha256(`message:${seed}`)
  return {
    challengeId: randomUUID(),
    reviewerWallet: '0x0000000000000000000000000000000000000001',
    role: 'security',
    releaseCommit,
    artifactSha256,
    publicKeyFingerprintSha256,
    attestationDigest,
    decision: 'approved',
    nonce: sha256(`nonce:${seed}`),
    messageHash,
    signature: `0x${'11'.repeat(65)}`,
    issuedAt,
    expiresAt,
    metadata: {
      authority: 'reviewer_attestation_verification_only',
      reviewerWallet: '0x0000000000000000000000000000000000000001',
      role: 'security',
      releaseCommit,
      artifactSha256,
      publicKeyFingerprintSha256,
      attestationDigest
    }
  }
}

async function insertChallenge(client, fixture, overrides = {}) {
  const value = { ...fixture, ...overrides }
  await client.query(
    `INSERT INTO reviewer_attestation_challenges
      (id, reviewer_wallet, role, release_commit, artifact_sha256,
       public_key_fingerprint_sha256,        decision, nonce, message_hash,
       issued_at, expires_at, consumed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      value.challengeId,
      value.reviewerWallet,
      value.role,
      value.releaseCommit,
      value.artifactSha256,
      value.publicKeyFingerprintSha256,
      value.decision,
      value.nonce,
      value.messageHash,
      value.issuedAt,
      value.expiresAt,
      value.consumedAt || null
    ]
  )
}

async function insertAttestation(client, fixture, overrides = {}) {
  const value = { ...fixture, ...overrides }
  await client.query(
    `INSERT INTO reviewer_attestations
      (challenge_id, reviewer_wallet, role, release_commit, artifact_sha256,
       public_key_fingerprint_sha256, attestation_digest, decision, signature,
       issued_at, expires_at, metadata, applied, release_eligible,
       settlement_authority, mutation, deployment_performed,
       settlement_mutation_performed)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb,
             $13, $14, $15, $16, $17, $18)`,
    [
      value.challengeId,
      value.reviewerWallet,
      value.role,
      value.releaseCommit,
      value.artifactSha256,
      value.publicKeyFingerprintSha256,
      value.attestationDigest,
      value.decision,
      value.signature,
      value.issuedAt,
      value.expiresAt,
      JSON.stringify(value.metadata),
      value.applied ?? false,
      value.releaseEligible ?? false,
      value.settlementAuthority ?? false,
      value.mutation ?? 'read_only',
      value.deploymentPerformed ?? false,
      value.settlementMutationPerformed ?? false
    ]
  )
}

async function verifyConstraintCatalog(client) {
  const indexes = await client.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'reviewer_attestations'
       AND indexname IN ('reviewer_attestations_role_commit_index', 'reviewer_attestations_commit_index')
     ORDER BY indexname
  `)
  assert.deepEqual(indexes.rows.map((row) => row.indexname), [
    'reviewer_attestations_commit_index',
    'reviewer_attestations_role_commit_index'
  ])

  const foreignKeys = await client.query(`
    SELECT constraint_name
      FROM information_schema.table_constraints
     WHERE table_schema = 'public'
       AND table_name = 'reviewer_attestations'
       AND constraint_type = 'FOREIGN KEY'
       AND constraint_name LIKE '%challenge%'
  `)
  assert.equal(foreignKeys.rows.length, 1)
  return { status: 'passed', uniqueIndexes: indexes.rows.map((row) => row.indexname), foreignKeyCount: foreignKeys.rows.length }
}

async function runContractSuite(pool) {
  const seed = randomUUID()
  const cleanupCommits = new Set()
  const results = {}

  try {
    results.catalog = await withTransaction(pool, (client) => verifyConstraintCatalog(client))

    const invalidRole = makeFixture(`${seed}:invalid-role`)
    cleanupCommits.add(invalidRole.releaseCommit)
    results.invalidChallengeRole = await expectSqlState(pool, 'invalid challenge role', '23514', (client) => insertChallenge(client, invalidRole, { role: 'not_a_role' }))

    const invalidHash = makeFixture(`${seed}:invalid-hash`)
    cleanupCommits.add(invalidHash.releaseCommit)
    results.invalidChallengeHash = await expectSqlState(pool, 'invalid challenge artifact hash', '23514', (client) => insertChallenge(client, invalidHash, { artifactSha256: 'bad' }))

    const invalidTime = makeFixture(`${seed}:invalid-time`)
    cleanupCommits.add(invalidTime.releaseCommit)
    results.invalidChallengeTime = await expectSqlState(pool, 'invalid challenge expiry ordering', '23514', (client) => insertChallenge(client, invalidTime, { expiresAt: invalidTime.issuedAt }))

    const missingChallenge = makeFixture(`${seed}:missing-challenge`)
    cleanupCommits.add(missingChallenge.releaseCommit)
    results.missingChallengeForeignKey = await expectSqlState(pool, 'missing challenge foreign key', '23503', (client) => insertAttestation(client, missingChallenge))

    const uniqueChallenge = makeFixture(`${seed}:unique-challenge`)
    cleanupCommits.add(uniqueChallenge.releaseCommit)
    await withTransaction(pool, async (client) => {
      await insertChallenge(client, uniqueChallenge)
      await insertAttestation(client, uniqueChallenge)
    })
    const duplicateChallengeDigest = sha256(`${seed}:duplicate-challenge`)
    results.duplicateChallenge = await expectSqlState(pool, 'duplicate challenge attestation', '23505', (client) => insertAttestation(client, uniqueChallenge, {
      attestationDigest: duplicateChallengeDigest,
      metadata: { ...uniqueChallenge.metadata, attestationDigest: duplicateChallengeDigest }
    }))

    const roleCommit = makeFixture(`${seed}:role-commit`)
    cleanupCommits.add(roleCommit.releaseCommit)
    const roleCommitSecond = makeFixture(`${seed}:role-commit-second`)
    roleCommitSecond.releaseCommit = roleCommit.releaseCommit
    roleCommitSecond.role = roleCommit.role
    roleCommitSecond.metadata = { ...roleCommitSecond.metadata, releaseCommit: roleCommit.releaseCommit }
    cleanupCommits.add(roleCommitSecond.releaseCommit)
    await withTransaction(pool, async (client) => {
      await insertChallenge(client, roleCommit)
      await insertAttestation(client, roleCommit)
      await insertChallenge(client, roleCommitSecond)
    })
    results.duplicateRoleCommit = await expectSqlState(pool, 'duplicate role and release commit', '23505', (client) => insertAttestation(client, roleCommitSecond))

    const immutable = makeFixture(`${seed}:immutable`)
    cleanupCommits.add(immutable.releaseCommit)
    await withTransaction(pool, (client) => insertChallenge(client, immutable))
    results.immutableFlags = {}
    for (const field of ['applied', 'releaseEligible', 'settlementAuthority', 'deploymentPerformed', 'settlementMutationPerformed']) {
      results.immutableFlags[field] = await expectSqlState(pool, `immutable ${field}`, '23514', (client) => insertAttestation(client, immutable, { [field]: true }))
    }
    results.immutableMutation = await expectSqlState(pool, 'immutable read-only mutation', '23514', (client) => insertAttestation(client, immutable, { mutation: 'write' }))

    const metadataMismatch = makeFixture(`${seed}:metadata-mismatch`)
    cleanupCommits.add(metadataMismatch.releaseCommit)
    await withTransaction(pool, (client) => insertChallenge(client, metadataMismatch))
    results.metadataMirror = await expectSqlState(pool, 'metadata release commit mirror', '23514', (client) => insertAttestation(client, metadataMismatch, { metadata: { ...metadataMismatch.metadata, releaseCommit: sha256(`${seed}:different`).slice(0, 40) } }))

    const nullRequired = makeFixture(`${seed}:null-required`)
    cleanupCommits.add(nullRequired.releaseCommit)
    await withTransaction(pool, (client) => insertChallenge(client, nullRequired))
    results.requiredColumn = await expectSqlState(pool, 'required reviewer wallet', '23502', (client) => insertAttestation(client, nullRequired, { reviewerWallet: null, metadata: { ...nullRequired.metadata, reviewerWallet: null } }))

    const consumedBeforeIssue = makeFixture(`${seed}:consumed-before-issue`)
    cleanupCommits.add(consumedBeforeIssue.releaseCommit)
    results.invalidConsumedTime = await expectSqlState(pool, 'consumed before issuance', '23514', (client) => insertChallenge(client, consumedBeforeIssue, { consumedAt: new Date('2026-08-15T23:59:00.000Z') }))

    return { status: 'verified', cases: results, cleanupCommits: cleanupCommits.size }
  } finally {
    const commits = [...cleanupCommits]
    await withTransaction(pool, async (client) => {
      await client.query('DELETE FROM reviewer_attestations WHERE release_commit = ANY($1::char(40)[])', [commits])
      await client.query('DELETE FROM reviewer_attestation_challenges WHERE release_commit = ANY($1::char(40)[])', [commits])
    })
  }
}

let databaseIsolation = false

async function main() {
  if (!ISOLATED) throw new Error('MIGRATION_019_CONTRACT_ISOLATED=true is required')
  assertDisposableDatabaseUrl(DATABASE_URL)
  databaseIsolation = true
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, min: 0, connectionTimeoutMillis: 5000 })
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool)
    console.log(json({
      ...report,
      migration: '019_reviewer_attestations',
      databaseIsolation: true,
      cleanupPerformed: true,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: '019_reviewer_attestations', databaseIsolation, cleanupPerformed: false, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
    process.exitCode = 1
  } finally {
    await pool.end()
  }
}

try {
  await main()
} catch (error) {
  console.error(json({
    status: 'blocked',
    reason: error.message,
    code: error.code || null,
    migration: '019_reviewer_attestations',
    databaseIsolation,
    cleanupPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }))
  process.exitCode = 1
}
