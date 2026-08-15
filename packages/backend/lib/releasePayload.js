import crypto from 'crypto'

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function buildSignedReleasePayload({ manifest, approval, railway, migration, recovery, signer = null, generatedAt = new Date().toISOString() }) {
  const evidence = { approval, generatedAt, manifest, migration, recovery, railway }
  const canonicalPayload = canonicalize(evidence)
  const signerReady = Boolean(signer?.privateKeyPem)
  const approvalReady = approval?.status === 'approved' && approval?.eligible === true
  const manifestReady = manifest?.status === 'ready'
  const migrationReady = migration?.status === 'passed'
  const recoveryReady = recovery?.status === 'verified'
  const railwayReady = railway?.status === 'matched'
  const ready = signerReady && approvalReady && manifestReady && migrationReady && recoveryReady && railwayReady
  let signature = null
  let publicKeyPem = null
  if (signerReady) {
    const privateKey = crypto.createPrivateKey(signer.privateKeyPem)
    signature = crypto.sign(null, Buffer.from(canonicalPayload), privateKey).toString('base64')
    publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
  }
  return {
    status: ready ? 'ready' : 'blocked',
    reason: ready ? 'all release evidence and operator signature are present' : 'release payload requires complete evidence and an operator signing key',
    canonicalPayload,
    signature,
    publicKeyPem,
    algorithm: 'ed25519',
    evidence,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    mutation: 'read_only'
  }
}

export function verifySignedReleasePayload(payload) {
  if (!payload?.signature || !payload?.publicKeyPem || !payload?.canonicalPayload || payload.algorithm !== 'ed25519' || !payload.evidence) return false
  const canonicalEvidence = canonicalize(payload.evidence)
  if (canonicalEvidence !== payload.canonicalPayload) return false
  const approvalReady = payload.evidence.approval?.status === 'approved' && payload.evidence.approval?.eligible === true
  const manifestReady = payload.evidence.manifest?.status === 'ready'
  const migrationReady = payload.evidence.migration?.status === 'passed'
  const recoveryReady = payload.evidence.recovery?.status === 'verified'
  const railwayReady = payload.evidence.railway?.status === 'matched'
  if (!approvalReady || !manifestReady || !migrationReady || !recoveryReady || !railwayReady) return false
  return crypto.verify(null, Buffer.from(payload.canonicalPayload), payload.publicKeyPem, Buffer.from(payload.signature, 'base64'))
}
