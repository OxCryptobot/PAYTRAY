import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { validateEvidencePath } from './verify-human-evidence-custody.mjs'

const COMMIT40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/
const TARGETS = new Set(['local_disposable', 'authenticated_target'])
const REQUIRED_ROLES = ['release_operator', 'protocol_finance', 'ai_data', 'security']
const SENSITIVE_KEY = /(?:private.?key|secret.?value|password|authorization|cookie|jwt|token|signature(?:bytes|material)?|raw.?content|transcript|recording|audio|video)/i
const SAFE_REDACTION_KEYS = new Set(['signatureBytesIncluded', 'signingKeyMaterialIncluded', 'identitiesIncluded', 'privateKeyMaterialIncluded', 'publicKeyMaterialIncluded', 'signatureMaterialIncluded', 'custodyManifestMaterialIncluded'])
const SAFE_BOOLEAN_KEYS = new Set(['independentAttestationSignatureVerified', 'signatureValid'])

function fail(message) {
  throw new Error(message)
}

function scanSensitiveKeys(value, currentPath = '$') {
  if (Array.isArray(value)) return value.flatMap((item, index) => scanSensitiveKeys(item, `${currentPath}[${index}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => {
    const safeMetadata = (SAFE_REDACTION_KEYS.has(key) && child === false) || (SAFE_BOOLEAN_KEYS.has(key) && typeof child === 'boolean')
    const forbidden = SENSITIVE_KEY.test(key) && !safeMetadata
    return [...(forbidden ? [`${currentPath}.${key}`] : []), ...scanSensitiveKeys(child, `${currentPath}.${key}`)]
  })
}

function assertSafeEvidence(value, label) {
  const sensitivePaths = scanSensitiveKeys(value)
  if (sensitivePaths.length) fail(`${label} contains sensitive keys: ${sensitivePaths.join(', ')}`)
  if (value?.releaseEligible === true || value?.settlementAuthority === true || value?.mutation !== undefined && value.mutation !== 'read_only') fail(`${label} contains an authority or mutation violation`)
}

function requireCommit(value, field) {
  if (typeof value !== 'string' || !COMMIT40.test(value.trim())) fail(`${field} must be a lowercase 40-character release commit`)
  return value.trim()
}

function requireHash(value, field) {
  if (typeof value !== 'string' || !HEX64.test(value.trim())) fail(`${field} must be a lowercase 64-character SHA-256`)
  return value.trim()
}

function readReport(filePath, label, { target, protectedRoot }) {
  const resolvedPath = validateEvidencePath(filePath, { label, target, protectedRoot })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail(`${label} is not valid JSON`)
  }
  assertSafeEvidence(value, label)
  return { value, sourceSha256: createHash('sha256').update(raw, 'utf8').digest('hex'), path: resolvedPath }
}

function step(name, verified, reasons, evidence = {}) {
  return { name, status: verified ? 'verified' : 'blocked', verified, reasons: [...new Set(reasons)], evidence }
}

function buildReleaseEvidenceStep(releaseEvidence) {
  const reasons = []
  const human = releaseEvidence?.humanSignoffs
  const attestation = releaseEvidence?.reviewerAttestationSummary
  const signing = releaseEvidence?.signingKeyEvidence
  if (human?.complete !== true) reasons.push('four human sign-offs are not complete')
  if (attestation?.complete !== true) reasons.push('four-role reviewer-attestation summary is not complete')
  if (signing?.ready !== true) reasons.push('release-evidence signing-key record is not ready')
  return step('release-evidence', reasons.length === 0, reasons, { humanSignoffsComplete: human?.complete === true, reviewerAttestationsComplete: attestation?.complete === true, signingKeyReady: signing?.ready === true })
}

function buildAttestationStep(bundle, commit, artifactSha256, fingerprint) {
  const reasons = []
  if (bundle?.status !== 'verified') reasons.push('attestation bundle status is not verified')
  if (bundle?.count !== 4) reasons.push('attestation bundle does not contain exactly four verified records')
  if (!Array.isArray(bundle?.roles) || REQUIRED_ROLES.some((role) => !bundle.roles.includes(role))) reasons.push('attestation bundle is missing one or more required roles')
  if (bundle?.releaseCommit !== commit) reasons.push('attestation bundle commit does not match')
  if (bundle?.artifactSha256 !== artifactSha256) reasons.push('attestation bundle artifact hash does not match')
  if (bundle?.publicKeyFingerprintSha256 !== fingerprint) reasons.push('attestation bundle public-key fingerprint does not match')
  return step('reviewer-attestation-bundle', reasons.length === 0, reasons, { count: bundle?.count || 0, roles: bundle?.roles || [] })
}

function buildCustodyStep(operator, secretManager, commit, fingerprint) {
  const reasons = []
  if (operator?.status !== 'verified') reasons.push('operator-key custody is not verified')
  if (operator?.releaseCommit !== commit) reasons.push('operator-key custody commit does not match')
  if (operator?.calculatedPublicKeyFingerprintSha256 !== fingerprint) reasons.push('derived public-key fingerprint does not match')
  if (operator?.independentVerification !== true || operator?.independentAttestationSignatureVerified !== true) reasons.push('independent security fingerprint attestation is not verified')
  if (secretManager?.status !== 'verified') reasons.push('secret-manager custody is not verified')
  if (secretManager?.releaseCommit !== commit) reasons.push('secret-manager custody commit does not match')
  if (secretManager?.publicKeyFingerprintSha256 !== fingerprint) reasons.push('secret-manager fingerprint does not match')
  if (secretManager?.ephemeralInjectionVerified !== true || secretManager?.privateKeyMaterialIncluded === true) reasons.push('ephemeral secret-manager injection is not verified')
  return step('operator-key-and-secret-manager-custody', reasons.length === 0, reasons, { operatorStatus: operator?.status || null, secretManagerStatus: secretManager?.status || null })
}

function buildManifestStep(manifest, commit, artifactSha256) {
  const reasons = []
  if (manifest?.status !== 'ready') reasons.push('release manifest is not ready')
  if (manifest?.gitCommit !== commit) reasons.push('manifest commit does not match')
  if (!Array.isArray(manifest?.artifacts) || manifest.artifacts.length === 0) reasons.push('manifest artifact list is missing')
  if (manifest?.manifestHash && !HEX64.test(manifest.manifestHash)) reasons.push('manifest hash is malformed')
  if (artifactSha256 && manifest?.artifactSha256 && manifest.artifactSha256 !== artifactSha256) reasons.push('manifest artifact hash does not match attestation bundle')
  return step('release-manifest', reasons.length === 0, reasons, { status: manifest?.status || null, manifestHash: manifest?.manifestHash || null })
}

function buildPayloadStep(payload, commit, manifestStep) {
  const reasons = []
  if (payload?.status !== 'verified') reasons.push('signed payload status is not verified')
  if (payload?.signatureValid !== true || payload?.evidenceReady !== true) reasons.push('signed payload signature/evidence verification did not pass')
  if (payload?.releaseCommit && payload.releaseCommit !== commit) reasons.push('signed payload commit does not match')
  if (!manifestStep.verified) reasons.push('payload cannot pass before the release manifest is verified')
  return step('signed-release-payload', reasons.length === 0, reasons, { signatureValid: payload?.signatureValid === true, evidenceReady: payload?.evidenceReady === true })
}

export function buildCryptographicReleaseSequence({ releaseEvidence, attestationBundle, operatorKeyCustody, secretManagerCustody, releaseManifest, signedPayload, releaseCommit, artifactSha256, publicKeyFingerprintSha256, target = 'local_disposable' } = {}) {
  if (!TARGETS.has(target)) fail('unsupported cryptographic sequence target')
  const commit = requireCommit(releaseCommit || releaseEvidence?.releaseCommit || attestationBundle?.releaseCommit || operatorKeyCustody?.releaseCommit || secretManagerCustody?.releaseCommit, 'releaseCommit')
  const artifact = requireHash(artifactSha256 || attestationBundle?.artifactSha256, 'artifactSha256')
  const fingerprint = requireHash(publicKeyFingerprintSha256 || attestationBundle?.publicKeyFingerprintSha256 || operatorKeyCustody?.calculatedPublicKeyFingerprintSha256, 'publicKeyFingerprintSha256')
  assertSafeEvidence(releaseEvidence, 'release evidence')
  assertSafeEvidence(attestationBundle, 'attestation bundle')
  assertSafeEvidence(operatorKeyCustody, 'operator-key custody')
  assertSafeEvidence(secretManagerCustody, 'secret-manager custody')
  assertSafeEvidence(releaseManifest, 'release manifest')
  assertSafeEvidence(signedPayload, 'signed payload')

  const releaseStep = buildReleaseEvidenceStep(releaseEvidence)
  const attestationStep = buildAttestationStep(attestationBundle, commit, artifact, fingerprint)
  const custodyStep = buildCustodyStep(operatorKeyCustody, secretManagerCustody, commit, fingerprint)
  const manifestStep = buildManifestStep(releaseManifest, commit, artifact)
  const payloadStep = buildPayloadStep(signedPayload, commit, manifestStep)
  const steps = [releaseStep, attestationStep, custodyStep, manifestStep, payloadStep]
  const blockers = steps.flatMap((item) => item.verified ? [] : item.reasons.map((reason) => ({ step: item.name, reason })))
  return {
    status: blockers.length === 0 ? 'verified' : 'blocked',
    target,
    releaseCommit: commit,
    artifactSha256: artifact,
    publicKeyFingerprintSha256: fingerprint,
    steps,
    blockers,
    cryptographicSequenceComplete: blockers.length === 0,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'cryptographic_release_sequence_evidence_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const target = process.env.CRYPTO_SEQUENCE_TARGET || 'local_disposable'
    const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
    const options = { target, protectedRoot }
    const releaseEvidence = readReport(process.env.CRYPTO_RELEASE_EVIDENCE_FILE, 'cryptographic release evidence', options)
    const attestationBundle = readReport(process.env.CRYPTO_ATTESTATION_BUNDLE_FILE, 'cryptographic attestation bundle', options)
    const operatorKeyCustody = readReport(process.env.CRYPTO_OPERATOR_KEY_CUSTODY_FILE, 'cryptographic operator-key custody', options)
    const secretManagerCustody = readReport(process.env.CRYPTO_SECRET_MANAGER_CUSTODY_FILE, 'cryptographic secret-manager custody', options)
    const releaseManifest = readReport(process.env.CRYPTO_RELEASE_MANIFEST_FILE, 'cryptographic release manifest', options)
    const signedPayload = readReport(process.env.CRYPTO_RELEASE_PAYLOAD_FILE, 'cryptographic signed payload', options)
    const report = buildCryptographicReleaseSequence({
      releaseEvidence: releaseEvidence.value,
      attestationBundle: attestationBundle.value,
      operatorKeyCustody: operatorKeyCustody.value,
      secretManagerCustody: secretManagerCustody.value,
      releaseManifest: releaseManifest.value,
      signedPayload: signedPayload.value,
      releaseCommit: process.env.CRYPTO_RELEASE_COMMIT,
      artifactSha256: process.env.CRYPTO_ARTIFACT_SHA256,
      publicKeyFingerprintSha256: process.env.CRYPTO_PUBLIC_KEY_FINGERPRINT_SHA256,
      target
    })
    console.log(JSON.stringify({
      ...report,
      sourceHashes: {
        releaseEvidence: releaseEvidence.sourceSha256,
        attestationBundle: attestationBundle.sourceSha256,
        operatorKeyCustody: operatorKeyCustody.sourceSha256,
        secretManagerCustody: secretManagerCustody.sourceSha256,
        releaseManifest: releaseManifest.sourceSha256,
        signedPayload: signedPayload.sourceSha256
      }
    }, null, 2))
    process.exitCode = report.status === 'verified' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({ status: 'blocked', reason: error instanceof Error ? error.message : String(error), releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false, deploymentPerformed: false, settlementMutationPerformed: false, authority: 'cryptographic_release_sequence_evidence_only' }, null, 2))
    process.exitCode = 1
  }
}
