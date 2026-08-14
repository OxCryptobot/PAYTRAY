function check(name, ready, reason, evidence = null) {
  return { name, ready: Boolean(ready), reason, evidence }
}

export function buildReleaseApprovalArtifact({ deploymentPreflight, readiness, reconciliation, verifierStatus, pendingShadowReviews = 0, rollbackTargets = 0, humanApproval = null }) {
  const checks = [
    check('deploymentPreflight', deploymentPreflight?.ready, deploymentPreflight?.ready ? 'deployment configuration preflight passed' : 'deployment configuration preflight requires attention', deploymentPreflight?.checks || null),
    check('database', readiness?.checks?.database?.ready, readiness?.checks?.database?.ready ? 'database ready' : 'database not ready', readiness?.checks?.database || null),
    check('verifier', verifierStatus?.ready === true && ['fresh'].includes(verifierStatus?.health?.status || verifierStatus?.status), 'durable verifier cursor must be fresh', verifierStatus || null),
    check('reconciliation', reconciliation?.status === 'ok', reconciliation?.status === 'ok' ? 'reconciliation clean' : 'reconciliation requires attention', reconciliation?.summary || null),
    check('shadowReview', Number(pendingShadowReviews) === 0, Number(pendingShadowReviews) === 0 ? 'no pending shadow reviews' : 'pending shadow reviews remain', { pendingShadowReviews: Number(pendingShadowReviews) }),
    check('rollbackTarget', Number(rollbackTargets) > 0, Number(rollbackTargets) > 0 ? 'rollback target evidence present' : 'rollback target evidence missing', { rollbackTargets: Number(rollbackTargets) }),
    check('mainnetPolicy', deploymentPreflight?.settlement?.chainId !== 8453 || deploymentPreflight?.settlement?.mainnetEnabled === true, 'mainnet policy must be explicit when Base mainnet is selected', deploymentPreflight?.settlement || null),
    check('humanApproval', humanApproval?.approved === true, humanApproval?.approved === true ? 'explicit human approval recorded' : 'explicit human approval is required', humanApproval || null)
  ]
  const eligible = checks.every((item) => item.ready)
  return {
    status: eligible ? 'approved' : 'blocked',
    eligible,
    approvalRequired: true,
    promotionStatus: 'shadow_only',
    authority: 'human_approval_required',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    generatedAt: new Date().toISOString(),
    checks
  }
}
