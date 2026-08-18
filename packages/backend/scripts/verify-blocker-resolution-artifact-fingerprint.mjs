import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SHA256 = /^[0-9a-f]{64}$/
const COMMIT40 = /^[0-9a-f]{40}$/

function fail(message) {
  throw new Error(message)
}

function readJson(filePath, label) {
  if (!filePath) fail(`${label} is required`)
  const raw = fs.readFileSync(filePath, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  return { raw, value }
}

function parseSidecar(sidecarPath, artifactPath) {
  const raw = fs.readFileSync(sidecarPath, 'utf8').trim()
  const match = raw.match(/^([0-9a-f]{64})\s+(.+)$/)
  if (!match) fail('blocker-resolution SHA-256 sidecar is malformed')
  const sidecarArtifact = match[2].trim()
  if (sidecarArtifact !== artifactPath && !sidecarArtifact.endsWith(`/${artifactPath}`)) fail('blocker-resolution sidecar path does not match artifact')
  return match[1]
}

function verifySafety(report) {
  if (report.releaseEligible === true) fail('artifact contains releaseEligible=true')
  if (report.settlementAuthority === true) fail('artifact contains settlementAuthority=true')
  if (report.applied === true) fail('artifact contains applied=true')
  if (report.deploymentPerformed === true) fail('artifact contains deploymentPerformed=true')
  if (report.settlementMutationPerformed === true) fail('artifact contains settlementMutationPerformed=true')
  if (!['read_only', 'none', null, undefined].includes(report.mutation)) fail('artifact contains an unsafe mutation value')
}

export function buildBlockerResolutionArtifactFingerprint({ artifactFile, sidecarFile, releaseCommit } = {}) {
  if (typeof releaseCommit !== 'string' || !COMMIT40.test(releaseCommit)) fail('releaseCommit must be a lowercase 40-character release commit')
  const artifact = readJson(artifactFile, 'artifactFile')
  if (artifact.value.reportKind !== 'release_blocker_resolution') fail('artifact reportKind must be release_blocker_resolution')
  verifySafety(artifact.value)
  if (artifact.value.releaseCommit !== releaseCommit) fail('artifact releaseCommit does not match requested release commit')
  const computedSha256 = createHash('sha256').update(artifact.raw, 'utf8').digest('hex')
  const sidecarSha256 = parseSidecar(sidecarFile, artifactFile)
  if (!SHA256.test(sidecarSha256) || sidecarSha256 !== computedSha256) fail('blocker-resolution artifact SHA-256 does not match sidecar')
  const blockerCount = Number(artifact.value.operatorBlockerCount)
  const unexpectedFailureCount = Number(artifact.value.unexpectedFailureCount)
  if (!Number.isInteger(blockerCount) || blockerCount < 0) fail('operatorBlockerCount must be a nonnegative integer')
  if (!Number.isInteger(unexpectedFailureCount) || unexpectedFailureCount < 0) fail('unexpectedFailureCount must be a nonnegative integer')
  return {
    reportKind: 'release_blocker_resolution_fingerprint',
    status: 'verified_reference',
    releaseCommit,
    artifactPath: artifactFile,
    sidecarPath: sidecarFile,
    artifactSha256: computedSha256,
    operatorBlockerCount: blockerCount,
    unexpectedFailureCount,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'blocker_resolution_artifact_fingerprint_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const report = buildBlockerResolutionArtifactFingerprint({
      artifactFile: process.env.BLOCKER_RESOLUTION_ARTIFACT_FILE,
      sidecarFile: process.env.BLOCKER_RESOLUTION_ARTIFACT_SIDECAR,
      releaseCommit: process.env.BLOCKER_RESOLUTION_ARTIFACT_COMMIT
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = 0
  } catch (error) {
    console.log(JSON.stringify({
      reportKind: 'release_blocker_resolution_fingerprint',
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'blocker_resolution_artifact_fingerprint_only'
    }, null, 2))
    process.exitCode = 1
  }
}
