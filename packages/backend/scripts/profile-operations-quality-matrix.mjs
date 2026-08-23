import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { buildOperationsQualityReport, classifyOperationsCheck } from '../lib/operationsQualityService.js'

const PARALLEL_SAFE_NAMES = Object.freeze(['extension-contract', 'sdk-contract', 'verifier-worker-config'])
const PARALLEL_SAFE_SET = new Set(PARALLEL_SAFE_NAMES)
const CHECKS = Object.freeze([
  ['quality-gate', 'backend:quality:check'],
  ['migrations', 'backend:migrations:check'],
  ['extension-contract', 'backend:extension:contract:check'],
  ['sdk-contract', 'backend:sdk:contract:check'],
  ['verifier-worker-config', 'backend:verifier:worker:check'],
  ['target-operations', 'backend:target:operations:check'],
  ['release-evidence', 'backend:release:evidence:check'],
  ['reconciliation-evidence', 'backend:reconciliation:evidence:check'],
  ['evidence-bundle', 'backend:ops:evidence:bundle:check'],
  ['release-gates', 'backend:release:gates:check'],
  ['secret-manager-custody', 'backend:release:key:secret-manager:check']
].map(([name, script], index) => Object.freeze({ index, name, script })))
const strict = String(process.env.OPERATIONS_QUALITY_STRICT || '').toLowerCase() === 'true'
const outputDirectory = path.resolve(process.env.OPERATIONS_QUALITY_PROFILE_OUTPUT_DIR || 'artifacts/operations-quality-profile-checks')
const outputPath = path.resolve(process.env.OPERATIONS_QUALITY_PROFILE_OUTPUT_PATH || 'artifacts/operations-quality-profile.json')
const concurrency = Number.parseInt(process.env.OPERATIONS_QUALITY_PROFILE_CONCURRENCY || '4', 10)
const childOutputLimit = 4 * 1024 * 1024

if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error('OPERATIONS_QUALITY_PROFILE_CONCURRENCY must be an integer from 1 through 4')
}

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

function safeMutation(value) {
  return value === 'read_only' ? 'read_only' : value || null
}

function runCheck(check) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env }
    if (check.name === 'quality-gate') delete childEnv.DATABASE_URL
    if (check.name === 'release-gates' && childEnv.RELEASE_GATES_STRICT === undefined) childEnv.RELEASE_GATES_STRICT = String(strict)

    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const startedAt = new Date().toISOString()
    const started = performance.now()
    const child = spawn(npmCommand, ['run', check.script], {
      cwd: process.cwd(),
      env: childEnv,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const appendBounded = (current, chunk) => current.length >= childOutputLimit ? current : `${current}${String(chunk).slice(0, childOutputLimit - current.length)}`
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk) })
    child.once('error', (error) => {
      finish({
        index: check.index,
        name: check.name,
        script: check.script,
        state: 'failed',
        status: 'unparseable',
        expectedBlocked: false,
        exitCode: 1,
        elapsedMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        startedAt,
        reason: `child process error: ${error.message}`,
        clearanceCriteria: null,
        authority: null,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: null,
        timingBasis: 'ci_step_diagnostic'
      })
    })
    child.once('close', (status) => {
      const parsed = extractJson(`${stdout}\n${stderr}`)
      const classified = classifyOperationsCheck({
        name: check.name,
        exitCode: status ?? 1,
        output: parsed ? JSON.stringify(parsed) : `${stdout}\n${stderr}`,
        strict
      })
      finish({
        ...classified,
        script: check.script,
        index: check.index,
        elapsedMs: Math.max(0, Math.round((performance.now() - started) * 100) / 100),
        startedAt,
        mutation: safeMutation(classified.mutation),
        timingBasis: 'ci_step_diagnostic'
      })
    })
  })
}

async function runChecks() {
  const results = new Array(CHECKS.length)
  for (const check of CHECKS) {
    if (!PARALLEL_SAFE_SET.has(check.name)) results[check.index] = await runCheck(check)
  }

  const parallelChecks = CHECKS.filter((check) => PARALLEL_SAFE_SET.has(check.name))
  let nextIndex = 0
  async function worker() {
    while (nextIndex < parallelChecks.length) {
      const index = nextIndex
      nextIndex += 1
      results[parallelChecks[index].index] = await runCheck(parallelChecks[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, parallelChecks.length) }, () => worker()))
  return results
}

const checks = await runChecks()
const generatedAt = new Date()
const baseReport = buildOperationsQualityReport({
  checks,
  strict,
  generatedAt,
  reportKind: 'operations_quality_profile'
})
const report = {
  ...baseReport,
  profileConcurrency: concurrency,
  parallelSafeChecks: [...PARALLEL_SAFE_NAMES],
  serialChecks: CHECKS.filter((check) => !PARALLEL_SAFE_SET.has(check.name)).map((check) => check.name),
  timingBasis: 'ci_step_diagnostic',
  authority: 'operations_quality_profile_diagnostic_only'
}

fs.mkdirSync(outputDirectory, { recursive: true })
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
for (const check of checks) {
  fs.writeFileSync(path.join(outputDirectory, `${String(check.index + 1).padStart(2, '0')}-${check.name}.json`), `${JSON.stringify(check, null, 2)}\n`)
}
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))

if (report.status === 'failed') process.exitCode = 1
