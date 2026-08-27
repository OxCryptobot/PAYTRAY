import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const ANSI_ESCAPE = String.fromCharCode(27)
const routePattern = /ErrorHandler|Database service error|Missing required scopes|Requested scope|Rate limit exceeded|Cannot view this stream|Only the stream recipient|Search query is required|challenge is invalid|LiveKit token service is not configured/i
const postgresPattern = /violates (?:check|foreign key|not-null)|duplicate key value/i
const stderrPattern = /stderr|status["']?:["']error|expected|fail-closed|failure mode/i
const artifactPattern = /artifacts?\/(?:restored|release|recovery)|status.*error/i
const processFailurePattern = /Process completed with (?:exit )?code [1-9]|Job failed|Unhandled|FATAL/i

function assertRegularNonSymlinkFile(filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    throw new Error(`CI log could not be inspected: ${error.message}`, { cause: error })
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('CI log must be a regular non-symlink file')
}

function emptyCategories() {
  return {
    errorHandlerNegativePath: [],
    postgresConstraintNegativePath: [],
    expectedTestStderr: [],
    expectedArtifactStatus: [],
    processFailureSignal: [],
    otherErrorLike: []
  }
}

const byJobStep = (records) => Object.entries(records.reduce((accumulator, record) => {
  const key = `${record.job ?? 'unknown'} :: ${record.step ?? 'unknown'}`
  accumulator[key] = (accumulator[key] ?? 0) + 1
  return accumulator
}, {})).map(([jobStep, count]) => ({ jobStep, count })).sort((a, b) => b.count - a.count || a.jobStep.localeCompare(b.jobStep))

function classifier() {
  return {
    precedence: ['errorHandlerNegativePath', 'postgresConstraintNegativePath', 'expectedTestStderr', 'expectedArtifactStatus', 'processFailureSignal', 'otherErrorLike'],
    routePattern: routePattern.source,
    postgresPattern: postgresPattern.source,
    processFailurePattern: processFailurePattern.source,
    errorLikePattern: '\\b(error|failure|failed|exception)\\b'
  }
}

function buildBlockedReport({ inputPath, runId, commit, reason }) {
  const categories = emptyCategories()
  return {
    run: runId,
    commit,
    source: inputPath ?? null,
    status: 'blocked',
    reason,
    classifier: classifier(),
    totalErrorLikeLines: 0,
    processFailureFree: false,
    authority: 'ci_log_audit_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    valid: false,
    categories: Object.fromEntries(Object.entries(categories).map(([name, records]) => [name, {
      count: records.length,
      byJobStep: byJobStep(records),
      lines: records
    }]))
  }
}

function main() {
  const inputPath = process.env.CI_LOG_PATH ?? process.argv[2]
  const outputPath = process.env.CI_NEGATIVE_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-ci-negative-lines.json'
  const runId = process.env.CI_RUN_ID ?? null
  const commit = process.env.CI_COMMIT ?? null
  const expectedRoute = process.env.EXPECT_ROUTE_NEGATIVE_COUNT === undefined ? null : Number(process.env.EXPECT_ROUTE_NEGATIVE_COUNT)
  const expectedPostgres = process.env.EXPECT_POSTGRES_NEGATIVE_COUNT === undefined ? null : Number(process.env.EXPECT_POSTGRES_NEGATIVE_COUNT)

  if (!inputPath) {
    console.error('CI_LOG_PATH or argv[2] is required')
    return 2
  }

  try {
    fs.lstatSync(inputPath)
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`CI log does not exist: ${inputPath}`)
      return 2
    }
    const blocked = buildBlockedReport({
      inputPath,
      runId,
      commit,
      reason: `CI log could not be inspected: ${error.message}`
    })
    console.error(JSON.stringify(blocked, null, 2))
    return 1
  }

  try {
    assertRegularNonSymlinkFile(inputPath)
    const raw = fs.readFileSync(inputPath, 'utf8')
      .replace(/\\u001b\\[[0-9;]*m/g, '')
      .replace(new RegExp(`${ANSI_ESCAPE}\\[[0-9;]*m`, 'g'), '')
    const categories = emptyCategories()

    for (const [index, originalLine] of raw.split('\n').entries()) {
      const line = originalLine.trimEnd()
      if (!/\b(error|failure|failed|exception)\b/i.test(line)) continue

      const fields = line.split('\t')
      const record = {
        logLine: index + 1,
        job: fields[0] || null,
        step: fields[1] || null,
        message: fields.slice(2).join('\t') || line,
        raw: line
      }

      if (routePattern.test(line)) categories.errorHandlerNegativePath.push(record)
      else if (postgresPattern.test(line)) categories.postgresConstraintNegativePath.push(record)
      else if (stderrPattern.test(line)) categories.expectedTestStderr.push(record)
      else if (artifactPattern.test(line)) categories.expectedArtifactStatus.push(record)
      else if (processFailurePattern.test(line)) categories.processFailureSignal.push(record)
      else categories.otherErrorLike.push(record)
    }

    const result = {
      run: runId,
      commit,
      source: inputPath,
      classifier: classifier(),
      totalErrorLikeLines: Object.values(categories).reduce((sum, records) => sum + records.length, 0),
      processFailureFree: categories.processFailureSignal.length === 0,
      authority: 'ci_log_audit_only',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      categories: Object.fromEntries(Object.entries(categories).map(([name, records]) => [name, {
        count: records.length,
        byJobStep: byJobStep(records),
        lines: records
      }]))
    }

    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify({
      outputPath,
      run: result.run,
      commit: result.commit,
      totalErrorLikeLines: result.totalErrorLikeLines,
      routeNegativeLines: result.categories.errorHandlerNegativePath.count,
      postgresNegativeLines: result.categories.postgresConstraintNegativePath.count,
      processFailureLines: result.categories.processFailureSignal.count,
      processFailureFree: result.processFailureFree
    }, null, 2))

    if (expectedRoute !== null && result.categories.errorHandlerNegativePath.count !== expectedRoute) return 1
    if (expectedPostgres !== null && result.categories.postgresConstraintNegativePath.count !== expectedPostgres) return 1
    return result.processFailureFree ? 0 : 1
  } catch (error) {
    const blocked = buildBlockedReport({ inputPath, runId, commit, reason: error.message })
    console.error(JSON.stringify(blocked, null, 2))
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()
