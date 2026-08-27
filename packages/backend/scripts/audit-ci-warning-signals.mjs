import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const warningPattern = /\b(?:warning|warnings|deprecated|deprecationwarning|experimentalwarning)\b|npm warn/i
const processFailurePattern = /Process completed with (?:exit )?code [1-9]|Job failed|Unhandled|FATAL|npm ERR!/i

function assertRegularNonSymlinkFile(filePath) {
  let stat
  try {
    stat = fs.lstatSync(filePath)
  } catch (error) {
    throw new Error(`CI log could not be inspected: ${error.message}`, { cause: error })
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('CI log must be a regular non-symlink file')
}

function buildBlockedReport({ inputPath, failOnWarnings, reason }) {
  return {
    source: inputPath ?? null,
    status: 'blocked',
    reason,
    warningCount: 0,
    warnings: [],
    processFailureCount: 0,
    processFailures: [],
    warningFree: false,
    processFailureFree: false,
    failOnWarnings,
    authority: 'ci_log_audit_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    valid: false
  }
}

function main() {
  const inputPath = process.env.CI_LOG_PATH ?? process.argv[2]
  const outputPath = process.env.CI_WARNING_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-ci-warning-audit.json'
  const failOnWarnings = process.env.CI_FAIL_ON_WARNINGS === 'true'

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
    const blocked = buildBlockedReport({ inputPath, failOnWarnings, reason: `CI log could not be inspected: ${error.message}` })
    console.error(JSON.stringify(blocked, null, 2))
    return 1
  }

  try {
    assertRegularNonSymlinkFile(inputPath)
    const lines = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/)
    const warnings = []
    const processFailures = []

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (!line) continue
      const logLine = index + 1
      if (warningPattern.test(line)) warnings.push({ logLine, raw: line })
      if (processFailurePattern.test(line)) processFailures.push({ logLine, raw: line })
    }

    const result = {
      source: inputPath,
      warningCount: warnings.length,
      warnings,
      processFailureCount: processFailures.length,
      processFailures,
      warningFree: warnings.length === 0,
      processFailureFree: processFailures.length === 0,
      failOnWarnings,
      authority: 'ci_log_audit_only',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      valid: processFailures.length === 0 && (!failOnWarnings || warnings.length === 0)
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify({ outputPath, ...result }, null, 2))
    return result.valid ? 0 : 1
  } catch (error) {
    const blocked = buildBlockedReport({ inputPath, failOnWarnings, reason: error.message })
    console.error(JSON.stringify(blocked, null, 2))
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main()
