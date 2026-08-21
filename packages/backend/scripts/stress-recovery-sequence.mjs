import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { runMigrations } from '../lib/migrations.js'
import { summarizeChildProcessUsage, summarizeRecoveryResourceUsage } from '../lib/recoveryResourceTelemetry.js'
import { mergeDatabaseTelemetry } from '../lib/recoveryDatabaseTelemetry.js'

const execFile = promisify(execFileCallback)
const { Pool } = pg
const RECOVERY_SCRIPT = path.resolve(new URL('./verify-recovery-evidence.mjs', import.meta.url).pathname)
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const PHASES = ['backup', 'backup_integrity', 'catalog', 'restore', 'restore_verification']

function requiredEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

function parseInteger(name, fallback, { min, max }) {
  const raw = process.env[name]
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

function assertDisposableUrl(value, name) {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${name} must use PostgreSQL`)
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`${name} must target localhost for disposable stress`)
  if (url.search || url.hash) throw new Error(`${name} must not contain query or hash components`)
  return url
}

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(`unsafe database identifier: ${value}`)
  return `"${value}"`
}

function databaseUrl(baseUrl, databaseName) {
  const url = new URL(baseUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)).toFixed(2))
}

function summarize(values) {
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : null,
    mean: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null
  }
}

function safeFailureReport(commit, concurrency, requestedSequences, startedAt, reason) {
  return {
    reportKind: 'local_disposable_recovery_stress',
    status: 'blocked',
    releaseCommit: commit,
    environment: 'local_disposable',
    concurrency,
    requestedSequences,
    completedSequences: 0,
    failedSequences: 0,
    integrityFailures: 0,
    orchestrationElapsedMs: Math.max(0, Date.now() - startedAt),
    throughputPerSecond: 0,
    phaseLatencyMs: Object.fromEntries(PHASES.map((phase) => [phase, summarize([])])),
    resourceTelemetry: summarizeRecoveryResourceUsage([]),
    rto: {
      targetMs: null,
      targetConfigured: false,
      withinTarget: null,
      basis: 'not_configured'
    },
    reason,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

async function runCommand(binary, args, env = {}) {
  try {
    return await execFile(binary, args, {
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024
    })
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim().slice(0, 500) : error.message
    throw new Error(`${binary} failed: ${detail}`, { cause: error })
  }
}

async function createDatabase(adminPool, databaseName) {
  await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`)
}

async function dropDatabase(adminPool, databaseName) {
  await adminPool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [databaseName])
  await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`)
}

async function initializeSource(sourceUrl) {
  const pool = new Pool({ connectionString: sourceUrl, max: 2, connectionTimeoutMillis: 5000 })
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await runMigrations(client)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
    const result = await pool.query('SELECT COUNT(*)::int AS count FROM schema_migrations')
    if (result.rows[0]?.count !== 20) throw new Error(`source database has ${result.rows[0]?.count} migrations; expected 20`)
  } finally {
    await pool.end()
  }
}

async function executeWorker({ sourceUrl, restoreUrl, backupFile, commit, rtoTargetMs, restoreJobs }) {
  const env = {
    DATABASE_URL: sourceUrl,
    RECOVERY_BACKUP_FILE: backupFile,
    RECOVERY_RESTORE_DATABASE_URL: restoreUrl,
    RECOVERY_TARGET_ISOLATED: 'true',
    RELEASE_COMMIT: commit
  }
  if (rtoTargetMs !== null) env.RECOVERY_RTO_TARGET_MS = String(rtoTargetMs)
  if (restoreJobs !== null) {
    env.RECOVERY_RESTORE_JOBS = String(restoreJobs)
    env.RECOVERY_RESTORE_EXPERIMENT = 'local_disposable'
    env.RECOVERY_CAPTURE_CHILD_RESOURCE = 'true'
  }
  if (process.env.RECOVERY_CAPTURE_CHILD_RESOURCE === 'true') {
    env.RECOVERY_CAPTURE_CHILD_RESOURCE = 'true'
  }
  if (process.env.RECOVERY_CAPTURE_DATABASE_TELEMETRY === 'true') {
    env.RECOVERY_CAPTURE_DATABASE_TELEMETRY = 'true'
    env.RECOVERY_DATABASE_TELEMETRY_INTERVAL_MS = process.env.RECOVERY_DATABASE_TELEMETRY_INTERVAL_MS || '25'
    env.RECOVERY_DATABASE_TELEMETRY_MAX_SAMPLES = process.env.RECOVERY_DATABASE_TELEMETRY_MAX_SAMPLES || '120'
  }
  const startedAt = Date.now()
  const result = await runCommand(process.execPath, [RECOVERY_SCRIPT], env)
  const report = JSON.parse(String(result.stdout).trim())
  return {
    report,
    orchestrationElapsedMs: Date.now() - startedAt
  }
}

export function buildStressReport({ commit, concurrency, requestedSequences, workerResults, orchestrationElapsedMs, targetMs = null, restoreJobs = null }) {
  const successful = workerResults.filter((worker) => worker.report?.status === 'verified')
  const failed = workerResults.length - successful.length
  const integrityFailures = workerResults.filter((worker) => worker.report?.restore?.status !== 'verified').length
  const phaseLatencyMs = Object.fromEntries(PHASES.map((phase) => [
    phase,
    summarize(successful.map((worker) => worker.report.timing?.phases?.[phase]?.durationMs).filter(Number.isFinite))
  ]))
  const durations = successful.map((worker) => worker.report?.timing?.elapsedMs).filter(Number.isFinite)
  const resourceTelemetry = summarizeRecoveryResourceUsage(successful.map((worker) => worker.report?.timing?.resource?.process))
  const childProcessTelemetry = summarizeChildProcessUsage(successful.map((worker) => worker.report?.timing?.childProcesses?.restore))
  const databaseTelemetrySamples = successful.map((worker) => worker.report?.timing?.database).filter(Boolean)
  const databaseTelemetry = databaseTelemetrySamples.length ? mergeDatabaseTelemetry(databaseTelemetrySamples) : null
  const withinTarget = targetMs === null
    ? null
    : successful.length === workerResults.length && durations.every((duration) => duration <= targetMs)
  return {
    reportKind: 'local_disposable_recovery_stress',
    status: failed === 0 && integrityFailures === 0 ? 'verified' : 'blocked',
    releaseCommit: commit,
    environment: 'local_disposable',
    concurrency,
    requestedSequences,
    completedSequences: successful.length,
    failedSequences: failed,
    integrityFailures,
    orchestrationElapsedMs,
    throughputPerSecond: orchestrationElapsedMs > 0 ? Number((successful.length / (orchestrationElapsedMs / 1000)).toFixed(3)) : 0,
    sequenceElapsedMs: summarize(durations),
    phaseLatencyMs,
    resourceTelemetry,
    childProcessTelemetry,
    ...(databaseTelemetry ? { databaseTelemetry } : {}),
    restoreJobs,
    rto: {
      targetMs,
      targetConfigured: targetMs !== null,
      withinTarget,
      basis: targetMs === null ? 'not_configured' : 'operator_supplied_target'
    },
    workers: workerResults.map((worker) => ({
      workerId: worker.workerId,
      status: worker.report?.status || 'blocked',
      recoveryElapsedMs: worker.report?.timing?.elapsedMs ?? null,
      orchestrationElapsedMs: worker.orchestrationElapsedMs,
      restoreStatus: worker.report?.restore?.status || 'unknown',
      resource: worker.report?.timing?.resource?.process || null,
      databaseTelemetry: worker.report?.timing?.database || null,
      storageTelemetry: worker.report?.timing?.storage || null
    })),
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function runStress({ adminUrl, concurrency, commit, targetMs = null, restoreJobs = null }) {
  const admin = assertDisposableUrl(adminUrl, 'RECOVERY_STRESS_ADMIN_URL')
  const baseName = `paytray_recovery_stress_${process.pid}_${Date.now()}`
  const sourceName = `${baseName}_source`
  const sourceUrl = databaseUrl(admin.toString(), sourceName)
  const databases = [sourceName]
  const tempDir = path.join(os.tmpdir(), baseName)
  const startedAt = Date.now()
  const adminPool = new Pool({ connectionString: admin.toString(), max: concurrency + 2, connectionTimeoutMillis: 5000 })
  const workerResults = []
  try {
    await createDatabase(adminPool, sourceName)
    await initializeSource(sourceUrl)
    const jobs = Array.from({ length: concurrency }, async (_, index) => {
      const workerId = `worker-${index + 1}`
      const restoreName = `${baseName}_restore_${index + 1}`
      const backupFile = path.join(tempDir, `${workerId}.dump`)
      databases.push(restoreName)
      await createDatabase(adminPool, restoreName)
      const result = await executeWorker({
        sourceUrl,
        restoreUrl: databaseUrl(admin.toString(), restoreName),
        backupFile,
        commit,
        rtoTargetMs: targetMs,
        restoreJobs
      })
      workerResults.push({ workerId, ...result })
    })
    await mkdir(tempDir, { recursive: true })
    await Promise.all(jobs)
    return buildStressReport({
      commit,
      concurrency,
      requestedSequences: concurrency,
      workerResults,
      orchestrationElapsedMs: Date.now() - startedAt,
      targetMs,
      restoreJobs
    })
  } finally {
    for (const databaseName of [...databases].reverse()) {
      await dropDatabase(adminPool, databaseName).catch(() => {})
    }
    await adminPool.end()
    await rm(tempDir, { recursive: true, force: true })
  }
}

export async function main() {
  const commit = requiredEnv('RECOVERY_STRESS_RELEASE_COMMIT')
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('RECOVERY_STRESS_RELEASE_COMMIT must be 40 lowercase hexadecimal characters')
  if (process.env.RECOVERY_STRESS_ENVIRONMENT !== 'local_disposable') {
    throw new Error('RECOVERY_STRESS_ENVIRONMENT=local_disposable is required')
  }
  const concurrency = parseInteger('RECOVERY_STRESS_CONCURRENCY', 4, { min: 2, max: 8 })
  const targetMsRaw = process.env.RECOVERY_RTO_TARGET_MS
  const targetMs = targetMsRaw === undefined ? null : Number.parseInt(targetMsRaw, 10)
  if (targetMs !== null && (!Number.isInteger(targetMs) || targetMs < 1)) throw new Error('RECOVERY_RTO_TARGET_MS must be a positive integer when supplied')
  const restoreJobsRaw = process.env.RECOVERY_RESTORE_JOBS
  const restoreJobs = restoreJobsRaw === undefined ? null : Number.parseInt(restoreJobsRaw, 10)
  if (restoreJobs !== null && (!Number.isInteger(restoreJobs) || restoreJobs < 1 || restoreJobs > 4)) throw new Error('RECOVERY_RESTORE_JOBS must be an integer between 1 and 4')
  if (restoreJobs !== null && process.env.RECOVERY_RESTORE_EXPERIMENT !== 'local_disposable') throw new Error('RECOVERY_RESTORE_EXPERIMENT=local_disposable is required for restore jobs')
  const report = await runStress({
    adminUrl: requiredEnv('RECOVERY_STRESS_ADMIN_URL'),
    concurrency,
    commit,
    targetMs,
    restoreJobs
  })
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'verified') process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const startedAt = Date.now()
  try {
    await main()
  } catch (error) {
    const commit = process.env.RECOVERY_STRESS_RELEASE_COMMIT || null
    const concurrency = Number.parseInt(process.env.RECOVERY_STRESS_CONCURRENCY || '0', 10) || 0
    console.error(JSON.stringify(safeFailureReport(commit, concurrency, concurrency, startedAt, error.message), null, 2))
    process.exitCode = 1
  }
}
