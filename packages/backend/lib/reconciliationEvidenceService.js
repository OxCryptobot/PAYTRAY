import { canonicalizeEvidence, buildEvidenceFingerprint } from './evidenceFingerprint.js'

function canonicalize(value) {
  return canonicalizeEvidence(value)
}

export function buildReconciliationEvidence({ report, gitCommit = null, generatedAt = new Date() } = {}) {
  const normalizedReport = canonicalize(report || {})
  const evidenceHash = buildEvidenceFingerprint({ kind: 'reconciliation', content: normalizedReport }).value
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
