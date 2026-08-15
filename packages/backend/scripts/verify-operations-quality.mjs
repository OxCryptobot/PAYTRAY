import { spawnSync } from 'node:child_process'
import { classifyOperationsCheck, buildOperationsQualityReport, isOperationsQualityExitSuccess } from '../lib/operationsQualityService.js'

const strict = String(process.env.OPERATIONS_QUALITY_STRICT || '').toLowerCase() === 'true'
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

const results = checks.map(({ name, script }) => {
  const result = spawnSync(npmCommand, ['run', script], {
    cwd: process.cwd(),
    env: process.env,
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

const report = buildOperationsQualityReport({ checks: results, strict })
console.log(JSON.stringify({
  ...report,
  authority: 'operations_quality_only',
  executedWithoutDeployment: true,
  executedWithoutSettlementMutation: true
}, null, 2))

process.exitCode = isOperationsQualityExitSuccess(report) ? 0 : 1
