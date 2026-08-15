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
          completedAt: latest.completed_at instanceof Date ? latest.completed_at.toISOString() : latest.completed_at ? new Date(latest.completed_at).toISOString() : null
        }
      : null
  }
}

function bundleFingerprintContent({ evidenceComplete, references, quality } = {}) {
  return {
    bundleVersion: 'v1',
    evidenceComplete: evidenceComplete === true,
    references,
    quality,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only'
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
    content: bundleFingerprintContent({ evidenceComplete, references, quality })
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

export function verifyOperatorEvidenceBundle(bundle = {}) {
  const safetyValid = bundle.authority === 'operator_evidence_bundle_export_only' &&
    bundle.paymentStateAuthority === 'verifier_and_ledger_only' &&
    bundle.releaseEligible === false &&
    bundle.settlementAuthority === false &&
    bundle.mutation === 'read_only' &&
    bundle.deploymentPerformed === false &&
    bundle.settlementMutationPerformed === false
  const fingerprint = bundle.evidenceFingerprint || {}
  const expectedFingerprint = buildEvidenceFingerprint({
    kind: 'operator_evidence_bundle',
    content: bundleFingerprintContent({
      evidenceComplete: bundle.evidenceComplete,
      references: bundle.references,
      quality: bundle.quality
    })
  })
  const fingerprintValid = fingerprint.algorithm === expectedFingerprint.algorithm &&
    fingerprint.kind === expectedFingerprint.kind &&
    fingerprint.value === expectedFingerprint.value
  const schemaValid = bundle.bundleVersion === 'v1' &&
    ['blocked', 'complete_pending_release_gate'].includes(bundle.status) &&
    typeof bundle.references === 'object' && bundle.references !== null &&
    typeof bundle.quality === 'object' && bundle.quality !== null
  const verified = safetyValid && fingerprintValid && schemaValid
  return {
    status: verified ? 'verified' : 'blocked',
    verified,
    reason: verified ? null : !safetyValid ? 'immutable safety metadata is invalid' : !fingerprintValid ? 'evidence fingerprint does not match canonical content' : 'evidence bundle schema is invalid',
    expectedFingerprint,
    authority: 'operator_evidence_bundle_verifier_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { bundleFingerprintContent, qualitySummary }
