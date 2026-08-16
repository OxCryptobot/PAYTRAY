import { createHash, createPublicKey, createPrivateKey } from 'node:crypto'
const FINGERPRINT = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/

function validNonPlaceholder(value) {
  return typeof value === 'string' && value.trim() && !/[<>]/.test(value) && !/placeholder|example|replace[-_ ]?me/i.test(value)
}

function fingerprintPublicKeyPem(publicKeyPem) {
  return createHash('sha256').update(Buffer.from(publicKeyPem, 'utf8')).digest('hex')
}

function publicKeyDer(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' })
}

export function buildOperatorKeyCustodyEvidence({
  privateKeyPem = null,
  publicKeyPem = null,
  expectedPublicKeyFingerprintSha256 = null,
  fingerprintAttestation = null,
  releaseCommit = null,
  privateKeySource = null,
  keyVersion = null,
  protectedSecret = false,
  independentlyVerifiedFlag = false
} = {}) {
  const reasons = []
  const commit = typeof releaseCommit === 'string' && COMMIT.test(releaseCommit.trim().toLowerCase()) ? releaseCommit.trim().toLowerCase() : null
  const expectedFingerprint = typeof expectedPublicKeyFingerprintSha256 === 'string' && FINGERPRINT.test(expectedPublicKeyFingerprintSha256.trim().toLowerCase())
    ? expectedPublicKeyFingerprintSha256.trim().toLowerCase()
    : null
  const privateKeyPresent = typeof privateKeyPem === 'string' && privateKeyPem.length > 0
  const publicKeyPresent = typeof publicKeyPem === 'string' && publicKeyPem.length > 0
  let privateKey = null
  let publicKey = null
  let privateKeyParseable = false
  let publicKeyParseable = false
  let privateKeyAlgorithm = null
  let publicKeyAlgorithm = null

  if (privateKeyPresent) {
    try {
      privateKey = createPrivateKey(privateKeyPem)
      privateKeyParseable = true
      privateKeyAlgorithm = privateKey.asymmetricKeyType
    } catch {
      reasons.push('operator private key is not parseable')
    }
  } else {
    reasons.push('operator private key was not injected')
  }

  if (publicKeyPresent) {
    try {
      publicKey = createPublicKey(publicKeyPem)
      publicKeyParseable = true
      publicKeyAlgorithm = publicKey.asymmetricKeyType
    } catch {
      reasons.push('operator public key is not parseable')
    }
  } else {
    reasons.push('operator public key was not supplied for independent fingerprinting')
  }

  const derivedPublicKeyMatches = privateKeyParseable && publicKeyParseable && privateKeyAlgorithm === 'ed25519' && publicKeyAlgorithm === 'ed25519' && publicKeyDer(createPublicKey(privateKey)).equals(publicKeyDer(publicKey))
  if (privateKeyParseable && privateKeyAlgorithm !== 'ed25519') reasons.push('operator private key algorithm is not Ed25519')
  if (publicKeyParseable && publicKeyAlgorithm !== 'ed25519') reasons.push('operator public key algorithm is not Ed25519')
  if (privateKeyParseable && publicKeyParseable && !derivedPublicKeyMatches) reasons.push('derived public key does not match supplied public key')

  const calculatedFingerprint = publicKeyPresent ? fingerprintPublicKeyPem(publicKeyPem) : null
  const fingerprintMatchesExpected = Boolean(calculatedFingerprint && expectedFingerprint && calculatedFingerprint === expectedFingerprint)
  if (!fingerprintMatchesExpected) reasons.push('public-key fingerprint does not match the operator-supplied expected fingerprint')

  const independentAttestationValid = Boolean(
    fingerprintAttestation &&
    fingerprintAttestation.role === 'security' &&
    validNonPlaceholder(fingerprintAttestation.verifiedBy) &&
    validNonPlaceholder(fingerprintAttestation.attestationId) &&
    typeof fingerprintAttestation.verifiedAt === 'string' &&
    !Number.isNaN(Date.parse(fingerprintAttestation.verifiedAt)) &&
    fingerprintAttestation.publicKeyFingerprintSha256 === calculatedFingerprint &&
    fingerprintAttestation.releaseCommit === commit
  )
  if (!independentAttestationValid) reasons.push('independent security fingerprint attestation is missing or does not match the key and release commit')

  const custodyVerified = privateKeyPresent && privateKeyParseable && privateKeyAlgorithm === 'ed25519' && protectedSecret === true && privateKeySource === 'approved-secret-manager' && validNonPlaceholder(keyVersion)
  if (!custodyVerified) reasons.push('private-key custody is not verified against the approved secret-manager contract')

  const ready = reasons.length === 0 && independentlyVerifiedFlag === true
  if (independentlyVerifiedFlag !== true) reasons.push('independent fingerprint verification flag is not true')

  return {
    status: ready ? 'verified' : 'blocked',
    privateKeyPresent,
    privateKeyParseable,
    publicKeyPresent,
    publicKeyParseable,
    privateKeyAlgorithm,
    publicKeyAlgorithm,
    privateKeySource: privateKeySource === 'approved-secret-manager' ? privateKeySource : 'unverified',
    keyVersion: validNonPlaceholder(keyVersion) ? keyVersion : null,
    custodyVerified,
    derivedPublicKeyMatches,
    calculatedPublicKeyFingerprintSha256: calculatedFingerprint,
    expectedPublicKeyFingerprintSha256: expectedFingerprint,
    fingerprintMatchesExpected,
    independentVerification: independentlyVerifiedFlag === true && independentAttestationValid,
    attestationRole: independentAttestationValid ? 'security' : null,
    releaseCommit: commit,
    reasons: [...new Set(reasons)],
    privateKeyMaterialIncluded: false,
    publicKeyMaterialIncluded: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'operator_key_custody_evidence_only'
  }
}
