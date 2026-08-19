import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import pg from 'pg'
import { createRecoveryTiming } from '../lib/recoveryTiming.js'
import { createRecoveryResourceTelemetry } from '../lib/recoveryResourceTelemetry.js'

const execFile = promisify(execFileCallback)
const { Pool } = pg
const CHILD_PROCESS_MEASURER = path.resolve(new URL('./measure-child-process.mjs', import.meta.url).pathname)

const EXPECTED_TABLES = [
  'users',
  'payment_streams',
  'engagements',
  'payment_intents',
  'payment_chain_events',
  'ledger_accounts',
  'ledger_entries',
  'idempotency_records',
  'outbox_events',
  'financial_audit_events',
  'engagement_outcome_events',
  'ai_feature_snapshots',
  'ai_evaluation_examples',
  'ai_evaluation_runs',
  'ai_shadow_decisions',
  'discovery_impressions',
  'production_telemetry_events',
  'payment_verifier_cursors',
  'webhook_replay_claims',
  'verified_trust_signals',
  'webhook_inbox',
  'extension_hooks',
  'operations_quality_runs',
  'reviewer_attestation_challenges',
  'reviewer_attestations'
]

function safeDatabaseLabel(value) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.hostname}${url.pathname}`
  } catch {
    return 'unparseable-database-url'
  }
}

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function assertIsolatedTarget(sourceUrl, restoreUrl) {
  if (sourceUrl === restoreUrl) {
    throw new Error('RECOVERY_RESTORE_DATABASE_URL must differ from DATABASE_URL')
  }
  if (process.env.RECOVERY_TARGET_ISOLATED !== 'true') {
    throw new Error('RECOVERY_TARGET_ISOLATED=true is required before restoring')
  }
}

async function runCommand(binary, args) {
  try {
    return await execFile(binary, args, { maxBuffer: 16 * 1024 * 1024 })
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim().slice(0, 500) : error.message
    throw new Error(`${binary} failed: ${detail}`)
  }
}

function parseChildResource(stderr) {
  const line = String(stderr).split(/\r?\n/).find((value) => value.startsWith('PAYTRAY_CHILD_RESOURCE '))
  if (!line) return null
  try {
    const resource = JSON.parse(line.slice('PAYTRAY_CHILD_RESOURCE '.length))
    if (resource.basis !== 'procfs_child_process') throw new Error('invalid child resource basis')
    return resource
  } catch (error) {
    throw new Error(`invalid child process resource output: ${error.message}`)
  }
}

async function runMeasuredCommand(binary, args) {
  if (process.env.RECOVERY_CAPTURE_CHILD_RESOURCE !== 'true') return { ...(await runCommand(binary, args)), resource: null }
  const measured = await runCommand(process.execPath, [CHILD_PROCESS_MEASURER, binary, ...args])
  return { ...measured, resource: parseChildResource(measured.stderr) }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function verifyRestoredDatabase(connectionString) {
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000 })
  try {
    const tables = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      ORDER BY table_name
    `, [EXPECTED_TABLES])
    const migrations = await pool.query('SELECT migration_name FROM schema_migrations ORDER BY migration_name')
    const actualTables = tables.rows.map((row) => row.table_name)
    const actualMigrations = migrations.rows.map((row) => row.migration_name)
    const missingTables = EXPECTED_TABLES.filter((table) => !actualTables.includes(table))
    if (missingTables.length > 0) {
      throw new Error(`isolated restore is missing tables: ${missingTables.join(', ')}`)
    }
    if (actualMigrations.length !== 19) {
      throw new Error(`isolated restore has ${actualMigrations.length} migrations; expected 19`)
    }
    return {
      status: 'verified',
      tableCount: actualTables.length,
      migrationCount: actualMigrations.length,
      database: safeDatabaseLabel(connectionString)
    }
  } finally {
    await pool.end()
  }
}

const recoveryTiming = createRecoveryTiming()
const recoveryResourceTelemetry = createRecoveryResourceTelemetry()
  const configuredRtoMs = Number.parseInt(process.env.RECOVERY_RTO_TARGET_MS || '', 10)
  const restoreJobsRaw = process.env.RECOVERY_RESTORE_JOBS
  const restoreJobs = restoreJobsRaw === undefined ? null : Number.parseInt(restoreJobsRaw, 10)
  if (restoreJobs !== null && (!Number.isInteger(restoreJobs) || restoreJobs < 1 || restoreJobs > 4)) throw new Error('RECOVERY_RESTORE_JOBS must be an integer between 1 and 4')
  if (restoreJobs !== null && process.env.RECOVERY_RESTORE_EXPERIMENT !== 'local_disposable') throw new Error('RECOVERY_RESTORE_EXPERIMENT=local_disposable is required for restore jobs')
  let restoreResource = null

async function measurePhase(name, operation) {
  return recoveryTiming.measure(name, () => recoveryResourceTelemetry.measure(name, operation))
}

try {
  const sourceUrl = requiredEnv('DATABASE_URL')
  const backupFile = path.resolve(requiredEnv('RECOVERY_BACKUP_FILE'))
  const restoreUrl = process.env.RECOVERY_RESTORE_DATABASE_URL || null
  await fs.mkdir(path.dirname(backupFile), { recursive: true })

  await measurePhase('backup', () => runCommand(process.env.PG_DUMP_BIN || 'pg_dump', [
    sourceUrl,
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file',
    backupFile
  ]))
  await fs.chmod(backupFile, 0o600)
  const { backupStat, backupSha256 } = await measurePhase('backup_integrity', async () => ({
    backupStat: await fs.stat(backupFile),
    backupSha256: await sha256File(backupFile)
  }))
  const catalog = await measurePhase('catalog', () => runCommand(process.env.PG_RESTORE_BIN || 'pg_restore', ['--list', backupFile]))
  const catalogEntries = String(catalog.stdout).split('\n').filter((line) => line && !line.startsWith(';')).length

  let restore = { status: 'not_requested' }
  if (restoreUrl) {
    assertIsolatedTarget(sourceUrl, restoreUrl)
    await measurePhase('restore', async () => {
      const args = [
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        ...(restoreJobs === null ? [] : [`--jobs=${restoreJobs}`]),
        '--dbname',
        restoreUrl,
        backupFile
      ]
      const result = await runMeasuredCommand(process.env.PG_RESTORE_BIN || 'pg_restore', args)
      restoreResource = result.resource
      return result
    })
    restore = await measurePhase('restore_verification', () => verifyRestoredDatabase(restoreUrl))
  }

  const recoveryStatus = restore.status === 'verified' ? 'verified' : 'schema_catalog_only'
  console.log(JSON.stringify({
    reportKind: 'recovery_evidence',
    status: recoveryStatus,
    sourceDatabase: safeDatabaseLabel(sourceUrl),
    backup: {
      path: backupFile,
      bytes: backupStat.size,
      sha256: backupSha256,
      catalogEntries,
      format: 'custom',
      ownerAndPrivilegesExcluded: true
    },
    restore,
    authority: 'recovery_evidence_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: restore.status === 'verified' ? 'isolated_recovery_only' : 'backup_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    timing: {
      ...recoveryTiming.snapshot({ rtoTargetMs: configuredRtoMs }),
      resource: recoveryResourceTelemetry.snapshot(),
      ...(restoreResource ? { childProcesses: { restore: restoreResource } } : {})
    },
    ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
  }, null, 2))
  process.exitCode = recoveryStatus === 'verified' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    reportKind: 'recovery_evidence',
    status: 'blocked',
    reason: error.message,
    authority: 'recovery_evidence_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'none',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    timing: {
      ...recoveryTiming.snapshot({ rtoTargetMs: configuredRtoMs }),
      resource: recoveryResourceTelemetry.snapshot(),
      ...(restoreResource ? { childProcesses: { restore: restoreResource } } : {})
    },
    ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
  }, null, 2))
  process.exitCode = 1
}
