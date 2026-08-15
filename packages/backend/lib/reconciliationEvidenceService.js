import crypto from 'node:crypto'

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

export function buildReconciliationEvidence({ report, gitCommit = null, generatedAt = new Date() } = {}) {
  const normalizedReport = canonicalize(report || {})
  const canonicalJson = JSON.stringify(normalizedReport)
  const evidenceHash = crypto.createHash('sha256').update(canonicalJson).digest('hex')
  const issues = Array.isArray(report?.issues) ? report.issues : []
  return {
    status: report?.status === 'ok' ? 'verified' : 'attention',
    generatedAt: generatedAt.toISOString(),
    evidenceHash,
    gitCommit,
    report: normalizedReport,
    issueCount: issues.length,
    authority: 'read_only_reconciliation_report',
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { canonicalize }
