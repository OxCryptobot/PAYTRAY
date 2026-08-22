import fs from 'node:fs'

const inputPath = process.env.CI_NEGATIVE_JSON_PATH ?? process.argv[2]
const outputPath = process.env.CI_POSTGRES_VERIFICATION_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-postgres-taxonomy-verification.json'
const expectedCountRaw = process.env.EXPECT_POSTGRES_RECORD_COUNT
const expectedCount = expectedCountRaw === undefined ? null : Number.parseInt(expectedCountRaw, 10)

if (!inputPath) {
  console.error('CI_NEGATIVE_JSON_PATH or argv[2] is required')
  process.exit(2)
}
if (!fs.existsSync(inputPath)) {
  console.error(`taxonomy JSON does not exist: ${inputPath}`)
  process.exit(2)
}
if (expectedCountRaw !== undefined && (!Number.isInteger(expectedCount) || expectedCount < 0)) {
  console.error('EXPECT_POSTGRES_RECORD_COUNT must be a non-negative integer when provided')
  process.exit(2)
}

const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'))
const records = source?.categories?.postgresConstraintNegativePath?.lines
if (!Array.isArray(records)) {
  console.error('taxonomy JSON is missing categories.postgresConstraintNegativePath.lines')
  process.exit(2)
}

const familyPatterns = {
  check: /violates check constraint/i,
  unique: /duplicate key value violates unique constraint/i,
  foreign_key: /violates foreign key constraint/i,
  not_null: /violates not-null constraint/i
}
const allowedJobs = new Set([
  'Disposable backup and isolated recovery contract',
  'Isolated PostgreSQL route contract'
])
const errors = []
const families = {}
const jobs = {}
const lineNumbers = new Set()

for (const record of records) {
  const raw = typeof record?.raw === 'string' ? record.raw : ''
  const logLine = record?.logLine
  if (!Number.isInteger(logLine) || logLine < 1) errors.push({ record, error: 'invalid log line number' })
  if (lineNumbers.has(logLine)) errors.push({ logLine, error: 'duplicate log line number' })
  lineNumbers.add(logLine)
  if (!raw.includes('ERROR:')) errors.push({ logLine, error: 'missing PostgreSQL ERROR marker' })

  const matches = Object.entries(familyPatterns).filter(([, pattern]) => pattern.test(raw)).map(([family]) => family)
  if (matches.length !== 1) errors.push({ logLine, error: `expected one constraint family; found ${matches.join(',') || 'none'}` })
  else families[matches[0]] = (families[matches[0]] ?? 0) + 1

  if (!allowedJobs.has(record?.job)) errors.push({ logLine, error: 'unexpected owning job' })
  if (typeof record?.step !== 'string' || record.step.length === 0) errors.push({ logLine, error: 'missing owning step' })
  const jobStep = `${record?.job ?? 'unknown'} :: ${record?.step ?? 'unknown'}`
  jobs[jobStep] = (jobs[jobStep] ?? 0) + 1
}

const result = {
  source: inputPath,
  run: source.run ?? null,
  commit: source.commit ?? null,
  recordCount: records.length,
  expectedRecordCount: expectedCount,
  recordCountValid: expectedCount === null || records.length === expectedCount,
  constraintFamilyCounts: Object.fromEntries(Object.entries(families).sort()),
  jobStepCounts: Object.fromEntries(Object.entries(jobs).sort()),
  uniqueLogLineCount: lineNumbers.size,
  allRecordsHaveUniqueLineNumbers: lineNumbers.size === records.length,
  errors,
  authority: 'ci_log_audit_only',
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false,
  valid: (expectedCount === null || records.length === expectedCount) && lineNumbers.size === records.length && errors.length === 0
}
fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify({ outputPath, ...result }, null, 2))
if (!result.valid) process.exitCode = 1
