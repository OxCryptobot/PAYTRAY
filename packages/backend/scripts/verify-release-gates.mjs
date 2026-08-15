import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { classifyOperationsCheck, buildOperationsQualityReport, isOperationsQualityExitSuccess } from '../lib/operationsQualityService.js'

const strict = String(process.env.RELEASE_GATES_STRICT || '').toLowerCase() === 'true'
const runId = randomUUID()
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const checks = [
  { name: 'quality-gate', script: 'backend:quality:check' },
  { name: 'migrations', script: 'backend:migrations:check' },
  { name: 'recovery', script: 'backend:recovery:check' },
  { name: 'deployment-preflight', script: 'backend:deployment:check' },
  { name: 'railway-trial', script: 'backend:railway:trial:check' },
  { name: 'verifier-operations', script: 'backend:verifier:operations:check' },
  { name: 'outbox-health', script: 'backend:outbox:health:check' },
  { name: 'idempotency-cleanup', script: 'backend:idempotency:cleanup:check' },
  { name: 'target-operations', script: 'backend:target:operations:check' },
  { name: 'release-approval', script: 'backend:release:approval:check' },
  { name: 'release-evidence', script: 'backend:release:evidence:check' },
  { name: 'reconciliation-evidence', script: 'backend:reconciliation:evidence:check' },
  { name: 'release-manifest', script: 'backend:release:manifest:check' },
  { name: 'release-payload', script: 'backend:release:payload:check' },
  { name: 'advisory-ai', script: 'backend:advisory:ai:check' },
  { name: 'token-metadata', script: 'backend:token:metadata:check' },
  { name: 'smoke-phase2', script: 'backend:smoke:phase2:check' },
  { name: 'sdk-contract', script: 'backend:sdk:contract:check' },
  { name: 'extension-contract', script: 'backend:extension:contract:check' }
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
    return {
      ...classifyOperationsCheck({
        name,
        exitCode: result.status ?? 1,
        output: parsed ? JSON.stringify(parsed) : output,
        strict
      }),
      script
    }
  })
}

const report = buildOperationsQualityReport({ checks: runChecks(), strict })
console.log(JSON.stringify({
  ...report,
  runId,
  authority: 'release_gate_inspection_only',
  paymentStateAuthority: 'verifier_and_ledger_only',
  executedWithoutDeployment: true,
  executedWithoutSettlementMutation: true
}, null, 2))
process.exitCode = isOperationsQualityExitSuccess(report) ? 0 : 1
