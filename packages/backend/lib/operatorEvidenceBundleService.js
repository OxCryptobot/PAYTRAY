import { buildEvidenceFingerprint } from './evidenceFingerprint.js'

function qualitySummary(runs = []) {
  const records = Array.isArray(runs) ? runs : []
  const latest = records[0] || null
  return {
    count: records.length,
    latest: latest
      ? {
          runId: latest.run_id,
          status: latest.status,
          strictMode: latest.strict_mode,
          checkCount: latest.check_count,
          passedCount: latest.passed_count,
          operatorBlockerCount: latest.operator_blocker_count,
          unexpectedFailureCount: latest.unexpected_failure_count,
          reportHash: latest.report_hash,
          completedAt: latest.completed_at
        }
      : null
  }
}

export function buildOperatorEvidenceBundle({
  releaseEvidence = null,
  reconciliationEvidence = null,
  operationsQualityRuns = null,
  gitCommit = process.env.RELEASE_GIT_COMMIT || null,
  now = new Date()
} = {}) {
  const reconciliationVerified = reconciliationEvidence?.status === 'verified'
  const evidenceComplete = releaseEvidence?.evidenceComplete === true && reconciliationVerified
  const quality = qualitySummary(operationsQualityRuns?.runs)
  const references = {
    releaseEvidenceFingerprint: releaseEvidence?.evidenceFingerprint?.value || null,
    reconciliationEvidenceHash: reconciliationEvidence?.evidenceHash || null,
    operationsQualityRunIds: (operationsQualityRuns?.runs || []).map((run) => run.run_id).filter(Boolean),
    gitCommit
  }
  const evidenceFingerprint = buildEvidenceFingerprint({
    kind: 'operator_evidence_bundle',
    content: {
      bundleVersion: 'v1',
      evidenceComplete,
      references,
      quality,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only'
    }
  })
  return {
    status: evidenceComplete ? 'complete_pending_release_gate' : 'blocked',
    bundleVersion: 'v1',
    generatedAt: now.toISOString(),
    evidenceComplete,
    gitCommit,
    references,
    quality,
    releaseEvidence,
    reconciliationEvidence,
    evidenceFingerprint,
    blockers: [
      ...(releaseEvidence?.blockers || []),
      ...(reconciliationVerified ? [] : [{ name: 'reconciliation', reason: 'reconciliation evidence is not verified' }])
    ],
    authority: 'operator_evidence_bundle_export_only',
    paymentStateAuthority: 'verifier_and_ledger_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { qualitySummary }
