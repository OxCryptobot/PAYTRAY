import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import pg from 'pg'

const execFile = promisify(execFileCallback)
const { Pool } = pg

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
  'extension_hooks'
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
    if (actualMigrations.length !== 17) {
      throw new Error(`isolated restore has ${actualMigrations.length} migrations; expected 17`)
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

try {
  const sourceUrl = requiredEnv('DATABASE_URL')
  const backupFile = path.resolve(requiredEnv('RECOVERY_BACKUP_FILE'))
  const restoreUrl = process.env.RECOVERY_RESTORE_DATABASE_URL || null
  await fs.mkdir(path.dirname(backupFile), { recursive: true })

  await runCommand(process.env.PG_DUMP_BIN || 'pg_dump', [
    sourceUrl,
    '--format=custom',
    '--no-owner',
    '--no-privileges',
    '--file',
    backupFile
  ])
  await fs.chmod(backupFile, 0o600)
  const backupStat = await fs.stat(backupFile)
  const backupSha256 = await sha256File(backupFile)
  const catalog = await runCommand(process.env.PG_RESTORE_BIN || 'pg_restore', ['--list', backupFile])
  const catalogEntries = String(catalog.stdout).split('\n').filter((line) => line && !line.startsWith(';')).length

  let restore = { status: 'not_requested' }
  if (restoreUrl) {
    assertIsolatedTarget(sourceUrl, restoreUrl)
    await runCommand(process.env.PG_RESTORE_BIN || 'pg_restore', [
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      restoreUrl,
      backupFile
    ])
    restore = await verifyRestoredDatabase(restoreUrl)
  }

  const recoveryStatus = restore.status === 'verified' ? 'verified' : 'schema_catalog_only'
  console.log(JSON.stringify({
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
    mutation: restore.status === 'verified' ? 'isolated_recovery_only' : 'backup_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = recoveryStatus === 'verified' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    authority: 'recovery_evidence_only',
    mutation: 'none',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
