import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = path.resolve(scriptDirectory, '../..')
const artifactDirectory = path.resolve(process.env.MIGRATION_AUDIT_ARTIFACT_DIR ?? process.argv[2] ?? path.join(repositoryDirectory, 'artifacts'))
const outputPath = process.env.RELEASE_ATTESTATION_ARTIFACT_OUTPUT_PATH ?? process.argv[3] ?? '/tmp/paytray-release-attestation-artifacts.json'

const requiredArtifacts = {
  'migration-source-traceability.json': 'assertion_traceability_audit_only',
  'migration-race-boundaries.json': 'race_boundary_audit_only',
  'migration-runtime-races.json': 'runtime_race_traceability_audit_only',
  'migration-future-boundary.json': 'future_migration_boundary_audit_only',
  'downstream-integration-boundary.json': 'downstream_integration_boundary_audit_only'
}
const safety = {
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false
}
const errors = []
const checks = {}

function addError(artifact, reason) {
  errors.push({ artifact, reason })
}

function containsSensitiveMaterial(value, location = '$') {
  if (typeof value === 'string') {
    return /(postgres(?:ql)?:\/\/|PGPASSWORD\s*=|JWT_SECRET\s*=|PRIVATE_KEY|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|Authorization:\s*Bearer)/i.test(value)
      ? location
      : null
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = containsSensitiveMaterial(value[index], `${location}[${index}]`)
      if (found) return found
    }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/(password|private.?key|secret|authorization|access.?token|refresh.?token)/i.test(key)) return `${location}.${key}`
      const found = containsSensitiveMaterial(child, `${location}.${key}`)
      if (found) return found
    }
  }
  return null
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

function readSidecar(sidecarPath, expectedReportName) {
  const value = readFileSync(sidecarPath, 'utf8').trim()
  const match = value.match(/^([a-f0-9]{64}) {2}(.+)$/i)
  if (!match) throw new Error('sidecar must contain a SHA-256 digest followed by the exact report path')
  if (match[2] !== `artifacts/${expectedReportName}`) throw new Error(`sidecar path must equal artifacts/${expectedReportName}`)
  return match[1].toLowerCase()
}

function regularFileState(filePath) {
  try {
    const stat = lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) return 'unsafe'
    return 'file'
  } catch {
    return 'missing'
  }
}

function verifyArtifact(name, authority) {
  const reportPath = path.join(artifactDirectory, name)
  const sidecarPath = `${reportPath}.sha256`
  const check = { report: name, sidecar: `${name}.sha256`, authority, present: false, checksumMatches: false, jsonValid: false, safe: false, valid: false }
  checks[name] = check
  const reportState = regularFileState(reportPath)
  const sidecarState = regularFileState(sidecarPath)
  if (reportState === 'missing') {
    addError(name, 'required report is missing')
    return
  }
  if (reportState === 'unsafe') {
    addError(name, 'report must be a regular non-symlink file')
    return
  }
  if (sidecarState === 'missing') {
    addError(name, 'required SHA-256 sidecar is missing')
    return
  }
  if (sidecarState === 'unsafe') {
    addError(name, 'SHA-256 sidecar must be a regular non-symlink file')
    return
  }
  check.present = true
  let content
  let report
  try {
    content = readFileSync(reportPath, 'utf8')
    report = JSON.parse(content)
    check.jsonValid = true
  } catch (error) {
    addError(name, `report is not valid JSON: ${error.message}`)
    return
  }
  try {
    const expected = readSidecar(sidecarPath, name)
    check.checksumMatches = expected === sha256(content)
    if (!check.checksumMatches) addError(name, 'SHA-256 sidecar does not match report bytes')
  } catch (error) {
    addError(name, `invalid SHA-256 sidecar: ${error.message}`)
  }
  const sensitiveLocation = containsSensitiveMaterial(report)
  check.safe = sensitiveLocation === null && report.valid === true && report.authority === authority && report.releaseEligible === false && report.settlementAuthority === false && report.mutation === 'read_only' && report.deploymentPerformed === false && report.settlementMutationPerformed === false && Array.isArray(report.errors) && report.errors.length === 0
  if (sensitiveLocation) addError(name, `sensitive material detected at ${sensitiveLocation}`)
  if (report.valid !== true) addError(name, 'report must assert valid=true')
  if (report.authority !== authority) addError(name, `authority must equal ${authority}`)
  for (const [field, expected] of Object.entries(safety)) {
    if (report[field] !== expected) addError(name, `${field} must remain ${JSON.stringify(expected)}`)
  }
  if (!Array.isArray(report.errors) || report.errors.length !== 0) addError(name, 'report errors must be an empty array')
  check.valid = check.present && check.checksumMatches && check.jsonValid && check.safe
}

if (!existsSync(artifactDirectory)) errors.push({ artifact: artifactDirectory, reason: 'artifact directory is missing' })
else {
  for (const [name, authority] of Object.entries(requiredArtifacts)) verifyArtifact(name, authority)
  const allowedEntries = new Set([...Object.keys(requiredArtifacts), ...Object.keys(requiredArtifacts).map((name) => `${name}.sha256`), path.basename(outputPath)])
  for (const name of readdirSync(artifactDirectory)) {
    if (!allowedEntries.has(name)) addError(name, 'unexpected entry in release-attestation bundle')
    else if (name !== path.basename(outputPath) && regularFileState(path.join(artifactDirectory, name)) !== 'file') addError(name, 'bundle entry must be a regular non-symlink file')
  }
}

const report = {
  status: errors.length === 0 ? 'verified' : 'blocked',
  artifactDirectory,
  requiredArtifacts: Object.keys(requiredArtifacts),
  checks,
  errors,
  authority: 'artifact_retention_audit_only',
  ...safety,
  valid: errors.length === 0
}
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console[report.valid ? 'log' : 'error'](JSON.stringify(report, null, 2))
if (!report.valid) process.exitCode = 1
