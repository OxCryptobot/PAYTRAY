import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const DEFAULT_TESTS = [
  'packages/backend/tests/recoveryDatabaseTelemetry.test.js',
  'packages/backend/tests/recoveryArtifactTiming.test.js',
  'packages/backend/tests/recoveryStress.test.js',
  'packages/backend/tests/recoveryStressBaseline.test.js',
  'packages/backend/tests/repeatRecoveryStress.test.js',
  'packages/backend/tests/migrations.test.js'
]

function runVitest(testFiles, outputFile) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now()
    const child = spawn('./node_modules/.bin/vitest', ['run', ...testFiles, '--reporter=json', `--outputFile=${outputFile}`], {
      cwd: path.resolve(new URL('../../../', import.meta.url).pathname),
      env: { ...process.env, DATABASE_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, elapsedMs: Number((performance.now() - startedAt).toFixed(2)), stdout, stderr }))
  })
}

function parseReporterPayload(raw) {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
}

function summarizeJsonReport(report) {
  const files = Array.isArray(report?.testResults) ? report.testResults : []
  return files.map((file) => ({
    name: file.name,
    status: file.status,
    startTime: file.startTime,
    endTime: file.endTime,
    durationMs: typeof file.endTime === 'number' && typeof file.startTime === 'number' ? file.endTime - file.startTime : null,
    assertionCount: Array.isArray(file.assertionResults) ? file.assertionResults.length : null,
    failedAssertions: Array.isArray(file.assertionResults) ? file.assertionResults.filter((result) => result.status === 'failed').length : null
  })).sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1))
}

export async function profileRecoveryPostgresTests({ testFiles = DEFAULT_TESTS, outputPath = '/tmp/paytray-test-profile.json' } = {}) {
  const vitestReportPath = `${outputPath}.vitest.json`
  const result = await runVitest(testFiles, vitestReportPath)
  let vitestReport = null
  try {
    vitestReport = JSON.parse(await fs.readFile(vitestReportPath, 'utf8'))
  } catch {
    vitestReport = parseReporterPayload(`${result.stdout}\n${result.stderr}`)
  }
  const report = {
    reportKind: 'local_test_hotspot_profile',
    status: result.code === 0 ? 'verified' : 'blocked',
    testFiles,
    process: {
      exitCode: result.code,
      signal: result.signal,
      wallElapsedMs: result.elapsedMs
    },
    reporterPayloadCaptured: vitestReport !== null,
    files: summarizeJsonReport(vitestReport),
    interpretation: 'Wall-clock and Vitest reporter timings identify engineering optimization targets only; no fixture, assertion, authority, payment, or deployment behavior was changed by this profile run.',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
  await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  return report
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const tests = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TESTS
    const report = await profileRecoveryPostgresTests({ testFiles: tests, outputPath: process.env.PAYTRAY_TEST_PROFILE_OUTPUT || '/tmp/paytray-test-profile.json' })
    console.log(JSON.stringify(report, null, 2))
    if (report.status !== 'verified') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ reportKind: 'local_test_hotspot_profile', status: 'blocked', reason: error.message, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }, null, 2))
    process.exitCode = 1
  }
}
