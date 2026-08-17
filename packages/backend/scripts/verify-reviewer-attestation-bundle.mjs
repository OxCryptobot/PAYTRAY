import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REQUIRED_ROLES = ['release_operator', 'protocol_finance', 'ai_data', 'security']
const COMMIT40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const WALLET = /^0x[0-9a-f]{40}$/
const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|reviewer.?notes|transcript|recording|audio|video)/i
const ALLOWED_MUTATIONS = new Set([null, 'none', 'read_only'])

function fail(message) {
  throw new Error(message)
}

function assertLowerHex(value, field, pattern) {
  if (typeof value !== 'string' || !pattern.test(value.trim())) fail(`${field} must be lowercase hexadecimal with the required length`)
  return value.trim()
}

function assertWallet(value, field) {
  if (typeof value !== 'string' || !WALLET.test(value.trim().toLowerCase())) fail(`${field} must be a valid Ethereum wallet`)
  return value.trim().toLowerCase()
}

function scanSensitiveKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed at ${path}.${key}`)
    scanSensitiveKeys(child, `${path}.${key}`)
  }
}

function normalizeAttestation(attestation, index) {
  if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) fail(`attestations[${index}] must be an object`)
  if (attestation.status !== undefined && attestation.status !== 'verified') fail(`attestations[${index}].status must be verified when supplied`)
  if (!REQUIRED_ROLES.includes(attestation.role)) fail(`attestations[${index}].role is not one of the four required roles`)
  const reviewerWallet = assertWallet(attestation.reviewerWallet || attestation.reviewer_wallet, `attestations[${index}].reviewerWallet`)
  const releaseCommit = assertLowerHex(attestation.releaseCommit || attestation.release_commit, `attestations[${index}].releaseCommit`, COMMIT40)
  const artifactSha256 = assertLowerHex(attestation.artifactSha256 || attestation.artifact_sha256, `attestations[${index}].artifactSha256`, HEX64)
  const publicKeyFingerprintSha256 = assertLowerHex(attestation.publicKeyFingerprintSha256 || attestation.public_key_fingerprint_sha256, `attestations[${index}].publicKeyFingerprintSha256`, HEX64)
  if ((attestation.decision || '') !== 'approved') fail(`attestations[${index}].decision must be approved`)
  for (const [field, expected] of [['applied', false], ['releaseEligible', false], ['release_eligible', false], ['settlementAuthority', false], ['settlement_authority', false], ['deploymentPerformed', false], ['settlementMutationPerformed', false]]) {
    if (attestation[field] !== undefined && attestation[field] !== expected) fail(`attestations[${index}].${field} must remain ${String(expected)}`)
  }
  const mutation = attestation.mutation ?? null
  if (!ALLOWED_MUTATIONS.has(mutation)) fail(`attestations[${index}].mutation must be null, none, or read_only`)
  return {
    role: attestation.role,
    reviewerWallet,
    releaseCommit,
    artifactSha256,
    publicKeyFingerprintSha256,
    decision: 'approved',
    mutation,
    releaseEligible: false,
    settlementAuthority: false,
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export function validateReviewerAttestationBundle({ content } = {}) {
  if (content == null) throw new TypeError('content is required')
  let report
  try {
    report = typeof content === 'string' ? JSON.parse(content) : content
  } catch {
    fail('reviewer attestation bundle is not valid JSON')
  }
  scanSensitiveKeys(report)
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('reviewer attestation bundle must be an object')
  if (report.status !== 'ok') fail('reviewer attestation bundle status must be ok')
  if (!Array.isArray(report.attestations)) fail('reviewer attestation bundle attestations must be an array')
  if (report.releaseEligible === true || report.settlementAuthority === true) fail('reviewer attestation bundle contains an immutable authority violation')
  const attestations = report.attestations.map(normalizeAttestation)
  if (attestations.length !== REQUIRED_ROLES.length) fail('reviewer attestation bundle must contain exactly four attestations')
  const roles = new Set()
  const wallets = new Set()
  for (const attestation of attestations) {
    if (roles.has(attestation.role)) fail(`duplicate attestation role: ${attestation.role}`)
    if (wallets.has(attestation.reviewerWallet)) fail('reviewer wallets must be distinct across the four roles')
    roles.add(attestation.role)
    wallets.add(attestation.reviewerWallet)
  }
  const missingRoles = REQUIRED_ROLES.filter((role) => !roles.has(role))
  if (missingRoles.length) fail(`missing required attestation roles: ${missingRoles.join(', ')}`)
  const releaseCommits = new Set(attestations.map((item) => item.releaseCommit))
  const artifactHashes = new Set(attestations.map((item) => item.artifactSha256))
  const fingerprints = new Set(attestations.map((item) => item.publicKeyFingerprintSha256))
  if (releaseCommits.size !== 1) fail('all attestations must bind to one release commit')
  if (artifactHashes.size !== 1) fail('all attestations must bind to one artifact SHA-256')
  if (fingerprints.size !== 1) fail('all attestations must bind to one public-key fingerprint SHA-256')
  return {
    status: 'verified',
    count: attestations.length,
    roles: REQUIRED_ROLES,
    releaseCommit: attestations[0].releaseCommit,
    artifactSha256: attestations[0].artifactSha256,
    publicKeyFingerprintSha256: attestations[0].publicKeyFingerprintSha256,
    attestations,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'reviewer_attestation_bundle_verification_only'
  }
}

function loadReport(filePath) {
  if (!filePath) fail('REVIEWER_ATTESTATIONS_FILE is required')
  const raw = fs.readFileSync(filePath, 'utf8')
  return {
    report: JSON.parse(raw),
    sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
    filePath
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { report, sourceSha256, filePath } = loadReport(process.argv[2] || process.env.REVIEWER_ATTESTATIONS_FILE)
    console.log(JSON.stringify({ filePath, sourceSha256, ...validateReviewerAttestationBundle({ content: report }) }, null, 2))
    process.exitCode = 0
  } catch (error) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      applied: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'reviewer_attestation_bundle_verification_only'
    }, null, 2))
    process.exitCode = 1
  }
}
