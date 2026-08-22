import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const backendDirectory = path.resolve(scriptDirectory, '..')
const repositoryDirectory = process.env.PAYTRAY_REPOSITORY_PATH
  ? path.resolve(process.env.PAYTRAY_REPOSITORY_PATH)
  : path.resolve(backendDirectory, '../..')
const outputPath = process.env.MIGRATION_FUTURE_BOUNDARY_OUTPUT_PATH
  ?? process.argv[2]
  ?? '/tmp/paytray-future-migration-boundary.json'

const expectedBoundary = { '021': 'not_present', '022': 'not_present' }
const errors = []
const checks = {}

function addError(boundary, reason) {
  errors.push({ boundary, reason })
}

function readOptional(relativePath) {
  const absolutePath = path.join(repositoryDirectory, relativePath)
  return existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : ''
}

function filesMatching(directory, pattern) {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => pattern.test(name)).sort()
}

const migrationsDirectory = path.join(repositoryDirectory, 'packages/backend/migrations')
const scriptsDirectory = path.join(repositoryDirectory, 'packages/backend/scripts')
for (const number of Object.keys(expectedBoundary)) {
  const sqlFiles = filesMatching(migrationsDirectory, new RegExp(`^${number}_.+\\.sql$`))
  const verifierFiles = filesMatching(scriptsDirectory, new RegExp(`^verify-migration-${number}-.+\\.mjs$`))
  checks[number] = {
    sqlFiles,
    verifierFiles,
    sqlStatus: sqlFiles.length === 0 ? 'not_present' : 'unexpected_present',
    verifierStatus: verifierFiles.length === 0 ? 'not_present' : 'unexpected_present'
  }
  if (sqlFiles.length > 0) addError(number, `migration-${number} SQL source must remain absent until an approved product/data contract exists`)
  if (verifierFiles.length > 0) addError(number, `migration-${number} verifier source must remain absent until migration implementation exists`)
}

const packageJson = readOptional('package.json')
const workflow = readOptional('.github/workflows/paytray-quality.yml')
const recoveryVerifier = readOptional('packages/backend/scripts/verify-recovery-artifact.mjs')
const sourceTraceability = readOptional('packages/backend/scripts/verify-postgres-assertion-traceability.mjs')
const boundaryOwner = readOptional('packages/backend/scripts/verify-migration-coverage.mjs')

const authorityChecks = {
  packageScripts: !/(backend:release:migration:0(?:21|22)(?::|"|'))/i.test(packageJson),
  workflowReferences: !/(?:migration-021|migration-022|restored-migration-021|restored-migration-022)/i.test(workflow),
  recoveryAllowlist: !/(?:migration-021|migration-022|restored-migration-021|restored-migration-022)/i.test(recoveryVerifier),
  sourceTraceability: !/(?:migration-021|migration-022|restored-migration-021|restored-migration-022)/i.test(sourceTraceability),
  coverageOwner: boundaryOwner.includes("futureBoundary: { '021': 'not_present', '022': 'not_present' }")
}
for (const [name, passed] of Object.entries(authorityChecks)) {
  if (!passed) addError(name, `${name} contains an unauthorized migration-021/022 contract reference`)
}

const report = {
  status: errors.length === 0 ? 'verified' : 'blocked',
  boundary: expectedBoundary,
  checks,
  authorityChecks,
  errors,
  authority: 'future_migration_boundary_audit_only',
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false,
  valid: errors.length === 0
}
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console[report.valid ? 'log' : 'error'](JSON.stringify(report, null, 2))
if (!report.valid) process.exitCode = 1
