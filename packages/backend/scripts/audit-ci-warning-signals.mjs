import fs from 'node:fs'

const inputPath = process.env.CI_LOG_PATH ?? process.argv[2]
const outputPath = process.env.CI_WARNING_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-ci-warning-audit.json'
const failOnWarnings = process.env.CI_FAIL_ON_WARNINGS === 'true'

if (!inputPath) {
  console.error('CI_LOG_PATH or argv[2] is required')
  process.exit(2)
}
if (!fs.existsSync(inputPath)) {
  console.error(`CI log does not exist: ${inputPath}`)
  process.exit(2)
}

const lines = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/)
const warningPattern = /\b(?:warning|warnings|deprecated|deprecationwarning|experimentalwarning)\b|npm warn/i
const processFailurePattern = /Process completed with (?:exit )?code [1-9]|Job failed|Unhandled|FATAL|npm ERR!/i
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
if (!result.valid) process.exitCode = 1
