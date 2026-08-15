import crypto from 'node:crypto'

export function canonicalizeEvidence(value) {
  if (Array.isArray(value)) return value.map(canonicalizeEvidence)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizeEvidence(value[key])]))
  }
  return value
}

export function buildEvidenceFingerprint({ kind, content } = {}) {
  if (!kind || typeof kind !== 'string') throw new Error('evidence fingerprint kind is required')
  const canonicalContent = canonicalizeEvidence(content || {})
  const canonicalJson = JSON.stringify({ kind, content: canonicalContent })
  return {
    algorithm: 'sha256',
    kind,
    value: crypto.createHash('sha256').update(canonicalJson).digest('hex')
  }
}
