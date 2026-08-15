function componentStatus(name, ready, status, reason, evidence = null) {
  return {
    name,
    ready: Boolean(ready),
    status: status || (ready ? 'ok' : 'blocked'),
    reason: reason || (ready ? `${name} is healthy` : `${name} requires attention`),
    evidence
  }
}

export function buildOperatorHealthDashboard({
  runtimeHealth = null,
  outboxHealth = null,
  webhookInboxHealth = null,
  verifierOperations = null,
  unifiedEvidence = null,
  now = new Date()
} = {}) {
  const components = [
    componentStatus(
      'runtimeHealth',
      runtimeHealth?.status === 'ok' && runtimeHealth?.ready === true,
      runtimeHealth?.status || 'unavailable',
      runtimeHealth?.status === 'ok' ? 'runtime health SLO and dependency checks passed' : runtimeHealth?.blockers?.[0]?.reason || 'runtime health is unavailable or degraded',
      runtimeHealth
    ),
    componentStatus(
      'outbox',
      outboxHealth?.status === 'ok',
      outboxHealth?.status || 'unavailable',
      outboxHealth?.status === 'ok' ? 'durable outbox delivery health is clean' : 'durable outbox delivery requires attention',
      outboxHealth
    ),
    componentStatus(
      'webhookInbox',
      webhookInboxHealth?.status === 'ok',
      webhookInboxHealth?.status || 'unavailable',
      webhookInboxHealth?.status === 'ok' ? 'durable webhook inbox health is clean' : 'durable webhook inbox requires attention',
      webhookInboxHealth
    ),
    componentStatus(
      'verifier',
      verifierOperations?.status === 'ready',
      verifierOperations?.status || 'unavailable',
      verifierOperations?.status === 'ready' ? 'verifier evidence is fresh, reconciled, and linked' : verifierOperations?.reason || 'verifier evidence is unavailable or blocked',
      verifierOperations
    ),
    componentStatus(
      'evidence',
      unifiedEvidence?.evidenceComplete === true,
      unifiedEvidence?.status || 'unavailable',
      unifiedEvidence?.evidenceComplete === true ? 'unified operator evidence is complete pending the release gate' : unifiedEvidence?.blockers?.[0]?.reason || 'unified operator evidence is incomplete',
      unifiedEvidence
    )
  ]
  const ready = components.every((component) => component.ready)
  return {
    status: ready ? 'ok' : 'degraded',
    ready,
    generatedAt: now.toISOString(),
    summary: {
      total: components.length,
      healthy: components.filter((component) => component.ready).length,
      blocked: components.filter((component) => !component.ready).length,
      blockedComponents: components.filter((component) => !component.ready).map((component) => component.name)
    },
    components,
    blockers: components.filter((component) => !component.ready).map(({ name, status, reason }) => ({ name, status, reason })),
    authority: 'operator_health_aggregation_only',
    paymentStateAuthority: 'verifier_and_ledger_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { componentStatus }
