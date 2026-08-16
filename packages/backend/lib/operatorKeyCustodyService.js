import { createHash, createPublicKey, createPrivateKey } from 'node:crypto'
import { getAddress, verifyMessage } from 'ethers'

const FINGERPRINT = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const SECRET_NAME = 'RELEASE_SIGNING_KEY_PEM'

function validNonPlaceholder(value) {
  return typeof value === 'string' && value.trim() && !/[<>]/.test(value) && !/placeholder|example|replace[-_ ]?me/i.test(value)
}

function normalizeCommit(value) {
  return typeof value === 'string' && COMMIT.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null
}

function normalizeFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null
}

function fingerprintPublicKeyPem(publicKeyPem) {
  return createHash('sha256').update(Buffer.from(publicKeyPem, 'utf8')).digest('hex')
}

function publicKeyDer(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' })
}

export function buildFingerprintAttestationMessage({ releaseCommit, publicKeyFingerprintSha256, secretName = SECRET_NAME, keyVersion } = {}) {
  return [
    'PayTray public-key fingerprint verification',
    `releaseCommit=${releaseCommit || ''}`,
    `publicKeyFingerprintSha256=${publicKeyFingerprintSha256 || ''}`,
    `secretName=${secretName || ''}`,
    `keyVersion=${keyVersion || ''}`
  ].join('\n')
}

function recoveredWalletFromAttestation(attestation) {
  try {
    if (!attestation?.signature || !attestation?.message || !attestation?.reviewerWallet) return null
    return getAddress(verifyMessage(attestation.message, attestation.signature))
  } catch {
    return null
  }
}

export function buildOperatorKeyCustodyEvidence({
  privateKeyPem = null,
  publicKeyPem = null,
  expectedPublicKeyFingerprintSha256 = null,
  fingerprintAttestation = null,
  custodyManifest = null,
  releaseCommit = null,
  privateKeySource = null,
  keyVersion = null,
  secretName = SECRET_NAME,
  protectedSecret = false,
  independentlyVerifiedFlag = false
} = {}) {
  const reasons = []
  const commit = normalizeCommit(releaseCommit)
  const expectedFingerprint = normalizeFingerprint(expectedPublicKeyFingerprintSha256)
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

  const normalizedSecretName = typeof secretName === 'string' && secretName.trim() ? secretName.trim() : SECRET_NAME
  const normalizedKeyVersion = validNonPlaceholder(keyVersion) ? keyVersion.trim() : null
  const custodyManifestVerified = Boolean(
    custodyManifest &&
    custodyManifest.provider === 'approved-secret-manager' &&
    custodyManifest.secretName === normalizedSecretName &&
    custodyManifest.version === normalizedKeyVersion &&
    custodyManifest.privateKeyPresent === true &&
    custodyManifest.privateKeyExported === false &&
    custodyManifest.accessMode === 'ephemeral' &&
    custodyManifest.publicKeyFingerprintSha256 === calculatedFingerprint &&
    custodyManifest.releaseCommit === commit &&
    typeof custodyManifest.retrievedAt === 'string' &&
    !Number.isNaN(Date.parse(custodyManifest.retrievedAt))
  )
  if (!custodyManifestVerified) reasons.push('secret-manager custody manifest is missing, mismatched, exported, or not ephemeral')

  const expectedAttestationMessage = buildFingerprintAttestationMessage({
    releaseCommit: commit,
    publicKeyFingerprintSha256: calculatedFingerprint,
    secretName: normalizedSecretName,
    keyVersion: normalizedKeyVersion
  })
  const recoveredWallet = recoveredWalletFromAttestation(fingerprintAttestation)
  let attestedWallet = null
  try {
    if (fingerprintAttestation?.reviewerWallet) attestedWallet = getAddress(fingerprintAttestation.reviewerWallet)
  } catch {
    attestedWallet = null
  }
  const independentAttestationSignatureVerified = Boolean(
    fingerprintAttestation &&
    fingerprintAttestation.role === 'security' &&
    validNonPlaceholder(fingerprintAttestation.attestationId) &&
    typeof fingerprintAttestation.verifiedAt === 'string' &&
    !Number.isNaN(Date.parse(fingerprintAttestation.verifiedAt)) &&
    fingerprintAttestation.releaseCommit === commit &&
    fingerprintAttestation.publicKeyFingerprintSha256 === calculatedFingerprint &&
    fingerprintAttestation.secretName === normalizedSecretName &&
    fingerprintAttestation.keyVersion === normalizedKeyVersion &&
    fingerprintAttestation.message === expectedAttestationMessage &&
    recoveredWallet !== null &&
    attestedWallet !== null &&
    recoveredWallet === attestedWallet
  )
  if (!independentAttestationSignatureVerified) reasons.push('independent security fingerprint signature is missing or does not match the key, custody manifest, or release commit')

  const custodyVerified = privateKeyPresent && privateKeyParseable && privateKeyAlgorithm === 'ed25519' && protectedSecret === true && privateKeySource === 'approved-secret-manager' && custodyManifestVerified
  if (!custodyVerified && !reasons.includes('secret-manager custody manifest is missing, mismatched, exported, or not ephemeral')) reasons.push('private-key custody is not verified against the approved secret-manager contract')

  if (independentlyVerifiedFlag !== true) reasons.push('independent fingerprint verification flag is not true')
  const ready = reasons.length === 0

  return {
    status: ready ? 'verified' : 'blocked',
    privateKeyPresent,
    privateKeyParseable,
    publicKeyPresent,
    publicKeyParseable,
    privateKeyAlgorithm,
    publicKeyAlgorithm,
    privateKeySource: privateKeySource === 'approved-secret-manager' ? privateKeySource : 'unverified',
    secretName: normalizedSecretName,
    keyVersion: normalizedKeyVersion,
    custodyVerified,
    custodyManifestVerified,
    derivedPublicKeyMatches,
    calculatedPublicKeyFingerprintSha256: calculatedFingerprint,
    expectedPublicKeyFingerprintSha256: expectedFingerprint,
    fingerprintMatchesExpected,
    independentAttestationSignatureVerified,
    independentVerification: independentlyVerifiedFlag === true && independentAttestationSignatureVerified,
    attestationRole: independentAttestationSignatureVerified ? 'security' : null,
    releaseCommit: commit,
    reasons: [...new Set(reasons)],
    privateKeyMaterialIncluded: false,
    publicKeyMaterialIncluded: false,
    signatureMaterialIncluded: false,
    custodyManifestMaterialIncluded: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'operator_key_custody_evidence_only'
  }
}
