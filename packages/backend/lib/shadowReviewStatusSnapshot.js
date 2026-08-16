const SAFE_DECISIONS = new Set(['pending', 'approved_pilot', 'rejected'])
const SAFE_STATUSES = new Set(['shadow', 'completed', 'archived'])

export function buildShadowReviewStatusSnapshot({ runs = [], expectedRunIds = [] } = {}) {
  const safeRuns = runs.map((run) => ({
    id: String(run.id),
    status: SAFE_STATUSES.has(run.status) ? run.status : 'unknown',
    reviewerDecision: SAFE_DECISIONS.has(run.reviewer_decision) ? run.reviewer_decision : 'unknown',
    reviewerAssigned: Boolean(run.reviewer_id),
    reviewedAt: run.reviewed_at || null,
    modelName: run.model_name || null,
    modelVersion: run.model_version || null,
    baselineVersion: run.baseline_version || null,
    datasetVersion: run.dataset_version || null,
    rollbackTarget: run.rollback_target || null
  }))
  const expected = expectedRunIds.map(String)
  const observedIds = new Set(safeRuns.map((run) => run.id))
  const missingRunIds = expected.filter((id) => !observedIds.has(id))
  const pendingCount = safeRuns.filter((run) => run.status === 'shadow' && run.reviewerDecision === 'pending').length
  const terminalCount = safeRuns.filter((run) => ['approved_pilot', 'rejected'].includes(run.reviewerDecision)).length
  return {
    status: missingRunIds.length > 0 ? 'incomplete' : pendingCount > 0 ? 'pending_human_review' : 'complete',
    expectedRunCount: expected.length,
    observedRunCount: safeRuns.length,
    pendingCount,
    terminalCount,
    missingRunIds,
    runs: safeRuns,
    submissionPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    authority: 'shadow_review_status_inspection_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}
