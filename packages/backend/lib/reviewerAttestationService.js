import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { verifyMessage } from 'ethers'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'

export const REVIEWER_ROLES = ['release_operator', 'protocol_finance', 'ai_data', 'security']
const DECISIONS = ['approved', 'rejected']
const HEX64 = /^[0-9a-f]{64}$/
const COMMIT40 = /^[0-9a-f]{40}$/
const WALLET = /^0x[0-9a-f]{40}$/
const SIGNATURE = /^0x[0-9a-f]{130}$/

function requiredLowerHex(value, field, pattern = HEX64) {
  if (typeof value !== 'string' || !pattern.test(value.trim().toLowerCase())) throw new ValidationError(`${field} must be lowercase hexadecimal with the required length`)
  return value.trim().toLowerCase()
}

function normalizeWallet(value) {
  if (typeof value !== 'string' || !WALLET.test(value.trim().toLowerCase())) throw new ValidationError('reviewer wallet must be a valid Ethereum address')
  return value.trim().toLowerCase()
}

function normalizeRole(role) {
  if (!REVIEWER_ROLES.includes(role)) throw new ValidationError(`reviewer role must be one of: ${REVIEWER_ROLES.join(', ')}`)
  return role
}

function normalizeDecision(decision) {
  if (!DECISIONS.includes(decision)) throw new ValidationError('attestation decision must be approved or rejected')
  return decision
}

export function buildReviewerAttestationMessage({ challengeId, reviewerWallet, role, releaseCommit, artifactSha256, publicKeyFingerprintSha256, decision, nonce, issuedAt, expiresAt }) {
  return [
    'PayTray reviewer attestation',
    `Challenge ID: ${challengeId}`,
    `Reviewer wallet: ${reviewerWallet}`,
    `Role: ${role}`,
    `Release commit: ${releaseCommit}`,
    `Artifact SHA-256: ${artifactSha256}`,
    `Public-key fingerprint SHA-256: ${publicKeyFingerprintSha256}`,
    `Decision: ${decision}`,
    `Nonce: ${nonce}`,
    `Issued at: ${issuedAt}`,
    `Expires at: ${expiresAt}`
  ].join('\n')
}

function hashText(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function buildAttestationDigest(challenge, signature) {
  return hashText(JSON.stringify({
    challengeId: challenge.id,
    reviewerWallet: challenge.reviewer_wallet,
    role: challenge.role,
    releaseCommit: challenge.release_commit,
    artifactSha256: challenge.artifact_sha256,
    publicKeyFingerprintSha256: challenge.public_key_fingerprint_sha256,
    decision: challenge.decision,
    messageHash: challenge.message_hash,
    signatureHash: hashText(signature)
  }))
}

export async function issueReviewerAttestationChallenge({ client, reviewerWallet, role, releaseCommit, artifactSha256, publicKeyFingerprintSha256, decision, ttlSeconds = 900 } = {}) {
  if (!client) throw new ValidationError('reviewer attestation challenge requires a database client')
  const wallet = normalizeWallet(reviewerWallet)
  const normalizedRole = normalizeRole(role)
  const commit = requiredLowerHex(releaseCommit, 'release commit', COMMIT40)
  const artifact = requiredLowerHex(artifactSha256, 'artifact SHA-256')
  const fingerprint = requiredLowerHex(publicKeyFingerprintSha256, 'public-key fingerprint SHA-256')
  const normalizedDecision = normalizeDecision(decision)
  const ttl = Number(ttlSeconds)
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) throw new ValidationError('attestation challenge TTL must be between 60 and 3600 seconds')
  const challengeId = randomUUID()
  const nonce = randomBytes(32).toString('hex')
  const issuedAt = new Date()
  const expiresAt = new Date(issuedAt.getTime() + ttl * 1000)
  const issuedAtIso = issuedAt.toISOString()
  const expiresAtIso = expiresAt.toISOString()
  const message = buildReviewerAttestationMessage({
    challengeId,
    reviewerWallet: wallet,
    role: normalizedRole,
    releaseCommit: commit,
    artifactSha256: artifact,
    publicKeyFingerprintSha256: fingerprint,
    decision: normalizedDecision,
    nonce,
    issuedAt: issuedAtIso,
    expiresAt: expiresAtIso
  })
  const messageHash = hashText(message)
  await client.query(
    `INSERT INTO reviewer_attestation_challenges
      (id, reviewer_wallet, role, release_commit, artifact_sha256, public_key_fingerprint_sha256, decision, nonce, message_hash, issued_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $11::timestamp)`,
    [challengeId, wallet, normalizedRole, commit, artifact, fingerprint, normalizedDecision, nonce, messageHash, issuedAtIso, expiresAtIso]
  )
  return {
    status: 'challenge_issued',
    challengeId,
    message,
    messageHash,
    reviewerWallet: wallet,
    role: normalizedRole,
    releaseCommit: commit,
    artifactSha256: artifact,
    publicKeyFingerprintSha256: fingerprint,
    decision: normalizedDecision,
    issuedAt: issuedAtIso,
    expiresAt: expiresAtIso,
    submissionPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    authority: 'reviewer_attestation_challenge_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function verifyReviewerAttestation({ client, challengeId, signature, authenticatedWallet } = {}) {
  if (!client) throw new ValidationError('reviewer attestation verification requires a database client')
  if (typeof challengeId !== 'string' || !challengeId.trim()) throw new ValidationError('challengeId is required')
  if (typeof signature !== 'string' || !SIGNATURE.test(signature.trim())) throw new ValidationError('signature must be a 65-byte EIP-191 signature')
  const authenticated = normalizeWallet(authenticatedWallet)
  const normalizedSignature = signature.trim()
  const result = await client.query('SELECT * FROM reviewer_attestation_challenges WHERE id = $1 FOR UPDATE', [challengeId])
  const challenge = result.rows[0]
  if (!challenge) throw new NotFoundError('Reviewer attestation challenge')
  if (challenge.reviewer_wallet.toLowerCase() !== authenticated) throw new ValidationError('authenticated reviewer wallet does not match the challenge wallet')
  if (challenge.consumed_at) throw new ConflictError('Reviewer attestation challenge was already consumed')
  if (new Date(challenge.expires_at).getTime() <= Date.now()) throw new ConflictError('Reviewer attestation challenge expired')
  const challengeMessage = challengeMessageFromRow(challenge)
  if (hashText(challengeMessage) !== challenge.message_hash) throw new ValidationError('reviewer attestation challenge message hash mismatch')
  let recoveredWallet
  try {
    recoveredWallet = verifyMessage(challengeMessage, normalizedSignature).toLowerCase()
  } catch (error) {
    throw new ValidationError(`reviewer signature verification failed: ${error.message}`)
  }
  if (recoveredWallet !== challenge.reviewer_wallet.toLowerCase()) throw new ValidationError('reviewer signature wallet does not match authenticated reviewer wallet')
  const attestationDigest = buildAttestationDigest(challenge, normalizedSignature)
  const signatureHash = hashText(normalizedSignature)
  const metadata = {
    authority: 'reviewer_attestation_verification_only',
    reviewerWallet: challenge.reviewer_wallet.toLowerCase(),
    role: challenge.role,
    releaseCommit: challenge.release_commit,
    artifactSha256: challenge.artifact_sha256,
    publicKeyFingerprintSha256: challenge.public_key_fingerprint_sha256,
    attestationDigest,
    signatureHash,
    decision: challenge.decision,
    applied: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
  const consumed = await client.query(
    'UPDATE reviewer_attestation_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1 AND consumed_at IS NULL RETURNING id',
    [challenge.id]
  )
  if (!consumed.rows[0]) throw new ConflictError('Reviewer attestation challenge was consumed concurrently')
  const inserted = await client.query(
    `INSERT INTO reviewer_attestations
      (challenge_id, reviewer_wallet, role, release_commit, artifact_sha256, public_key_fingerprint_sha256, attestation_digest, decision, signature, issued_at, expires_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamp, $11::timestamp, $12::jsonb)
     RETURNING id, verified_at, created_at`,
    [challenge.id, challenge.reviewer_wallet.toLowerCase(), challenge.role, challenge.release_commit, challenge.artifact_sha256, challenge.public_key_fingerprint_sha256, attestationDigest, challenge.decision, normalizedSignature, challenge.issued_at, challenge.expires_at, JSON.stringify(metadata)]
  )
  await client.query(
    `INSERT INTO financial_audit_events (actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ('operator', $1, 'reviewer_attestation_verified', 'reviewer_attestation', $2, $3::jsonb)`,
    [challenge.reviewer_wallet.toLowerCase(), inserted.rows[0].id, JSON.stringify(metadata)]
  )
  return {
    status: 'verified',
    attestationId: inserted.rows[0].id,
    challengeId: challenge.id,
    reviewerWallet: challenge.reviewer_wallet.toLowerCase(),
    role: challenge.role,
    releaseCommit: challenge.release_commit,
    artifactSha256: challenge.artifact_sha256,
    publicKeyFingerprintSha256: challenge.public_key_fingerprint_sha256,
    attestationDigest,
    signatureHash,
    decision: challenge.decision,
    verifiedAt: inserted.rows[0].verified_at,
    applied: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    authority: 'reviewer_attestation_verification_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

function challengeMessageFromRow(challenge) {
  return buildReviewerAttestationMessage({
    challengeId: challenge.id,
    reviewerWallet: challenge.reviewer_wallet,
    role: challenge.role,
    releaseCommit: challenge.release_commit,
    artifactSha256: challenge.artifact_sha256,
    publicKeyFingerprintSha256: challenge.public_key_fingerprint_sha256,
    decision: challenge.decision,
    nonce: challenge.nonce,
    issuedAt: new Date(challenge.issued_at).toISOString(),
    expiresAt: new Date(challenge.expires_at).toISOString()
  })
}

export async function listReviewerAttestations({ client, releaseCommit = null } = {}) {
  if (!client) throw new ValidationError('reviewer attestation listing requires a database client')
  const params = []
  let where = ''
  if (releaseCommit) {
    const commit = requiredLowerHex(releaseCommit, 'release commit', COMMIT40)
    params.push(commit)
    where = 'WHERE release_commit = $1'
  }
  const result = await client.query(
    `SELECT id, challenge_id, reviewer_wallet, role, release_commit, artifact_sha256,
            public_key_fingerprint_sha256, attestation_digest, decision, issued_at,
            expires_at, verified_at, created_at, applied, release_eligible,
            settlement_authority, mutation
     FROM reviewer_attestations ${where}
     ORDER BY created_at ASC, id ASC`,
    params
  )
  return {
    status: 'ok',
    count: result.rows.length,
    attestations: result.rows,
    submissionPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    authority: 'reviewer_attestation_inspection_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}
