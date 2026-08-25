import fs from 'node:fs/promises'
import { buildOperatorKeyCustodyEvidence } from '../lib/operatorKeyCustodyService.js'

async function assertRegularNonSymlinkFile(filePath, label) {
  let stats
  try {
    stats = await fs.lstat(filePath)
  } catch (error) {
    throw new Error(`${label} file cannot be inspected: ${error.message}`, { cause: error })
  }
  if (stats.isSymbolicLink()) throw new Error(`${label} file must not be a symlink`)
  if (!stats.isFile()) throw new Error(`${label} file must be a regular file`)
}

async function readOptionalJson(filePath, label) {
  if (!filePath) return null
  await assertRegularNonSymlinkFile(filePath, label)
  return JSON.parse(await fs.readFile(filePath, 'utf8'))
}

try {
  const fingerprintAttestation = await readOptionalJson(process.env.RELEASE_SIGNING_FINGERPRINT_ATTESTATION_FILE, 'RELEASE_SIGNING_FINGERPRINT_ATTESTATION_FILE')
  const custodyManifest = await readOptionalJson(process.env.RELEASE_SIGNING_CUSTODY_MANIFEST_FILE, 'RELEASE_SIGNING_CUSTODY_MANIFEST_FILE')
  const evidence = buildOperatorKeyCustodyEvidence({
    privateKeyPem: process.env.RELEASE_SIGNING_KEY_PEM || null,
    publicKeyPem: process.env.RELEASE_SIGNING_PUBLIC_KEY_PEM || null,
    expectedPublicKeyFingerprintSha256: process.env.RELEASE_SIGNING_PUBLIC_KEY_SHA256 || null,
    fingerprintAttestation,
    custodyManifest,
    releaseCommit: process.env.RELEASE_GIT_COMMIT || null,
    privateKeySource: process.env.RELEASE_SIGNING_KEY_SOURCE || null,
    keyVersion: process.env.RELEASE_SIGNING_KEY_VERSION || null,
    secretName: process.env.RELEASE_SIGNING_KEY_SECRET_NAME || 'RELEASE_SIGNING_KEY_PEM',
    protectedSecret: process.env.RELEASE_SIGNING_KEY_PROTECTED === 'true',
    independentlyVerifiedFlag: process.env.RELEASE_SIGNING_PUBLIC_KEY_FINGERPRINT_VERIFIED === 'true'
  })
  console.log(JSON.stringify(evidence, null, 2))
  process.exitCode = evidence.status === 'verified' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
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
  }, null, 2))
  process.exitCode = 1
}
