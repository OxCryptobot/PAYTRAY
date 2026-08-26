import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { validateCiMatrixArtifact } from './verify-ci-matrix-artifact.mjs'

function fail(message) {
  throw new Error(message)
}

function requireIsolatedMode() {
  if (process.env.OPERATIONS_QUALITY_ARTIFACT_ISOLATED !== 'true') fail('OPERATIONS_QUALITY_ARTIFACT_ISOLATED=true is required')
}

function assertRegularNonSymlinkFile(artifactPath) {
  let stat
  try {
    stat = fs.lstatSync(artifactPath)
  } catch (error) {
    fail(`${artifactPath} cannot be inspected: ${error.message}`)
  }
  if (stat.isSymbolicLink()) fail(`${artifactPath} must not be a symlink`)
  if (!stat.isFile()) fail(`${artifactPath} must be a regular file`)
}

function loadArtifact(artifactPath) {
  assertRegularNonSymlinkFile(artifactPath)
  let raw
  try {
    raw = fs.readFileSync(artifactPath, 'utf8')
  } catch (error) {
    fail(`operations-quality artifact cannot be read: ${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    fail('operations-quality artifact is not valid JSON')
  }
}

function validateAudit(artifact, requireAudit = false) {
  const audit = artifact.audit
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) fail('operations-quality artifact audit object is required')
  if (!['recorded', 'replayed', 'not_recorded'].includes(audit.status)) fail('operations-quality artifact audit status is invalid')
  if (requireAudit && !['recorded', 'replayed'].includes(audit.status)) {
    fail('operations-quality artifact requires durable migration-018 audit persistence')
  }
  if (audit.status === 'recorded' || audit.status === 'replayed') {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(audit.runId || ''))) fail('operations-quality audit runId is invalid')
    if (!/^[0-9a-f]{64}$/.test(String(audit.reportHash || ''))) fail('operations-quality audit reportHash is invalid')
  }
  for (const field of ['releaseEligible', 'settlementAuthority', 'deploymentPerformed', 'settlementMutationPerformed']) {
    if (audit[field] !== false) fail(`operations-quality audit ${field} must remain false`)
  }
  if (audit.mutation !== 'read_only') fail('operations-quality audit mutation must be read_only')
  return { status: audit.status, runId: audit.runId || null, reportHash: audit.reportHash || null }
}

export function validateOperationsQualityArtifact({ artifactPath, content, requireAudit = false } = {}) {
  if (!artifactPath && content == null) fail('artifact path or content is required')
  const artifact = content == null ? loadArtifact(artifactPath) : (() => {
    try {
      return JSON.parse(String(content))
    } catch {
      fail('operations-quality artifact is not valid JSON')
    }
  })()
  const report = validateCiMatrixArtifact({ artifactPath, content: content == null ? null : String(content), expectedReportKind: 'operations_quality' })
  const audit = validateAudit(artifact, requireAudit)
  return {
    status: 'verified',
    reportKind: report.reportKind,
    reportStatus: report.reportStatus,
    checkCount: report.checkCount,
    passedCount: report.passedCount,
    operatorBlockerCount: report.operatorBlockerCount,
    unexpectedFailureCount: report.unexpectedFailureCount,
    audit,
    authority: 'operations_quality_artifact_verification_only',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

function main() {
  const [artifactPath] = process.argv.slice(2)
  if (!artifactPath) fail('artifact path is required')
  requireIsolatedMode()
  console.log(JSON.stringify(validateOperationsQualityArtifact({
    artifactPath,
    requireAudit: process.env.OPERATIONS_QUALITY_ARTIFACT_REQUIRE_AUDIT === 'true'
  }), null, 2))
}

try {
  if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
} catch (error) {
  console.error(JSON.stringify({
    reportKind: 'operations_quality',
    status: 'blocked',
    reason: error.message,
    authority: 'operations_quality_artifact_verification_only',
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
