import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { recordOperationsQualityRun } from '../lib/operationsQualityAuditService.js'
import { classifyOperationsCheck, buildOperationsQualityReport, isOperationsQualityExitSuccess } from '../lib/operationsQualityService.js'

const strict = String(process.env.OPERATIONS_QUALITY_STRICT || '').toLowerCase() === 'true'
const runId = randomUUID()
const startedAt = new Date()
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const checks = [
  { name: 'quality-gate', script: 'backend:quality:check' },
  { name: 'migrations', script: 'backend:migrations:check' },
  { name: 'extension-contract', script: 'backend:extension:contract:check' },
  { name: 'sdk-contract', script: 'backend:sdk:contract:check' },
  { name: 'verifier-worker-config', script: 'backend:verifier:worker:check' },
  { name: 'target-operations', script: 'backend:target:operations:check' },
  { name: 'release-evidence', script: 'backend:release:evidence:check' },
  { name: 'reconciliation-evidence', script: 'backend:reconciliation:evidence:check' }
]

function extractJson(output) {
  const candidates = String(output || '').match(/\{[\s\S]*\}/g) || []
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(candidates[index])
    } catch {
      continue
    }
  }
  return null
}

function runChecks() {
  return checks.map(({ name, script }) => {
    const childEnv = { ...process.env }
    if (name === 'quality-gate') delete childEnv.DATABASE_URL
    const result = spawnSync(npmCommand, ['run', script], {
      cwd: process.cwd(),
      env: childEnv,
      encoding: 'utf8'
    })
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    const parsed = extractJson(output)
    const classified = classifyOperationsCheck({
      name,
      exitCode: result.status ?? 1,
      output: parsed ? JSON.stringify(parsed) : output,
      strict
    })
    return { ...classified, script }
  })
}

async function recordAudit(report, completedAt) {
  const safety = {
    authority: 'operations_quality_audit',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
  if (!process.env.DATABASE_URL) {
    return { status: 'not_recorded', reason: 'DATABASE_URL is not configured', ...safety }
  }
  try {
    await initializeDatabase()
    if (getDatabaseStatus() !== 'ready') {
      return { status: 'not_recorded', reason: 'database is not ready', ...safety }
    }
    const result = await transaction((client) => recordOperationsQualityRun({
      client,
      report,
      runId,
      startedAt,
      completedAt
    }))
    return {
      status: result.idempotentReplay ? 'replayed' : 'recorded',
      runId: result.runId,
      reportHash: result.reportHash,
      ...safety
    }
  } catch (error) {
    return { status: 'not_recorded', reason: 'durable audit persistence was unavailable', ...safety }
  } finally {
    await closeDatabase().catch(() => {})
  }
}

const report = buildOperationsQualityReport({ checks: runChecks(), strict })
const completedAt = new Date()
const audit = await recordAudit(report, completedAt)
console.log(JSON.stringify({
  ...report,
  runId,
  audit,
  authority: 'operations_quality_only',
  executedWithoutDeployment: true,
  executedWithoutSettlementMutation: true
}, null, 2))

process.exitCode = isOperationsQualityExitSuccess(report) ? 0 : 1
