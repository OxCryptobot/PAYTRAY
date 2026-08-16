import fs from 'node:fs/promises'

const FINGERPRINT = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const SECRET_NAME = 'RELEASE_SIGNING_KEY_PEM'

function validNonPlaceholder(value) {
  return typeof value === 'string' && value.trim() && !/[<>]/.test(value) && !/placeholder|example|replace[-_ ]?me/i.test(value)
}

function normalizeFingerprint(value) {
  return typeof value === 'string' && FINGERPRINT.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null
}

function normalizeCommit(value) {
  return typeof value === 'string' && COMMIT.test(value.trim().toLowerCase()) ? value.trim().toLowerCase() : null
}

function containsSecretFields(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((item, index) => containsSecretFields(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    const forbidden = /^(privatekey|privatekeypem|privatekeyvalue|secretvalue|signature|signaturebytes|token|password|authorization|publickeypem|publickeyvalue)$/.test(normalizedKey)
    return [...(forbidden ? [`${path}.${key}`] : []), ...containsSecretFields(child, `${path}.${key}`)]
  })
}

export function buildSecretManagerCustodyEvidence({ manifest = null, env = process.env, releaseCommit = null } = {}) {
  const reasons = []
  const commit = normalizeCommit(releaseCommit || env.RELEASE_GIT_COMMIT)
  const secretName = typeof env.RELEASE_SIGNING_KEY_SECRET_NAME === 'string' && env.RELEASE_SIGNING_KEY_SECRET_NAME.trim() ? env.RELEASE_SIGNING_KEY_SECRET_NAME.trim() : SECRET_NAME
  const version = typeof env.RELEASE_SIGNING_KEY_VERSION === 'string' && validNonPlaceholder(env.RELEASE_SIGNING_KEY_VERSION) ? env.RELEASE_SIGNING_KEY_VERSION.trim() : null
  const secretInjected = typeof env.RELEASE_SIGNING_KEY_PEM === 'string' && env.RELEASE_SIGNING_KEY_PEM.length > 0
  const secretSource = env.RELEASE_SIGNING_KEY_SOURCE || null
  const protectedSecret = env.RELEASE_SIGNING_KEY_PROTECTED === 'true'
  const persistedSecret = env.RELEASE_SIGNING_KEY_PERSISTED === 'true'
  const manifestSecretPaths = containsSecretFields(manifest)
  const fingerprint = normalizeFingerprint(manifest?.publicKeyFingerprintSha256)
  const manifestCommit = normalizeCommit(manifest?.releaseCommit)
  const manifestValid = Boolean(
    manifest &&
    manifest.provider === 'approved-secret-manager' &&
    manifest.secretName === secretName &&
    manifest.version === version &&
    manifest.privateKeyPresent === true &&
    manifest.privateKeyExported === false &&
    manifest.accessMode === 'ephemeral' &&
    fingerprint &&
    manifestCommit === commit &&
    typeof manifest.retrievedAt === 'string' &&
    !Number.isNaN(Date.parse(manifest.retrievedAt)) &&
    manifestSecretPaths.length === 0
  )
  if (!manifest) reasons.push('secret-manager custody manifest is not supplied')
  if (manifestSecretPaths.length > 0) reasons.push('custody manifest contains forbidden secret or key material fields')
  if (!manifestValid && manifest) reasons.push('secret-manager custody manifest is incomplete or mismatched')
  if (!secretInjected) reasons.push('private key was not injected into the ephemeral release process')
  if (secretSource !== 'approved-secret-manager') reasons.push('private key source is not approved-secret-manager')
  if (!version) reasons.push('immutable secret version is missing or a placeholder')
  if (!protectedSecret) reasons.push('private key protection flag is not true')
  if (persistedSecret) reasons.push('private key persistence flag must not be true for ephemeral injection')
  if (!commit) reasons.push('exact 40-character release commit is missing')

  const ready = reasons.length === 0
  return {
    status: ready ? 'verified' : 'blocked',
    provider: manifest?.provider || null,
    secretName,
    secretInjected,
    secretSource: secretSource === 'approved-secret-manager' ? secretSource : 'unverified',
    secretVersion: version,
    protectedSecret,
    persistedSecret,
    accessMode: manifest?.accessMode || null,
    manifestPresent: Boolean(manifest),
    manifestValid,
    manifestContainsSecretFields: manifestSecretPaths.length > 0,
    manifestSecretFieldPaths: manifestSecretPaths,
    publicKeyFingerprintSha256: fingerprint,
    releaseCommit: commit,
    ephemeralInjectionVerified: ready,
    secretMaterialIncluded: false,
    privateKeyMaterialIncluded: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'secret_manager_custody_evidence_only',
    reasons: [...new Set(reasons)]
  }
}

export async function loadSecretManagerCustodyManifest(filePath = process.env.RELEASE_SIGNING_CUSTODY_MANIFEST_FILE) {
  if (!filePath) return null
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}
