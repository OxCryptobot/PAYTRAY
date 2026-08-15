const CORE_STATUS = new Set(['ready', 'degraded', 'blocked', 'unconfigured', 'not_configured', 'unknown'])

function normalizeStatus(value, fallback = 'unknown') {
  const status = String(value || fallback).toLowerCase()
  return CORE_STATUS.has(status) ? status : 'unknown'
}

function check(name, status, ready, blocksCollaboration, reason) {
  return { name, status: normalizeStatus(status), ready: Boolean(ready), blocksCollaboration: Boolean(blocksCollaboration), reason }
}

export function buildCollaborationHealth({
  env = 'development',
  databaseStatus = 'unconfigured',
  livekitStatus = 'not_configured',
  sessionAuthStatus = 'ready',
  paymentRpcStatus = 'not_configured',
  verifierStatus = 'not_configured',
  indexerStatus = 'not_configured',
  now = new Date()
} = {}) {
  const databaseReady = databaseStatus === 'ready'
  const databaseDegraded = databaseStatus === 'unconfigured' && env !== 'production'
  const authReady = sessionAuthStatus === 'ready' || (sessionAuthStatus === 'unconfigured' && env !== 'production')
  const transportReady = livekitStatus === 'ready' || livekitStatus === 'configured'
  const checks = {
    engagementStore: check('engagementStore', databaseReady ? 'ready' : databaseDegraded ? 'degraded' : databaseStatus, databaseReady, databaseReady ? false : !databaseDegraded, databaseReady ? 'durable engagement store is available' : databaseDegraded ? 'development in-memory fallback is active; durable collaboration persistence is unavailable' : 'durable engagement store is unavailable'),
    sessionAuth: check('sessionAuth', authReady ? 'ready' : sessionAuthStatus, authReady, !authReady, authReady ? 'session authorization is available' : 'session authorization is unavailable'),
    realtimeTransport: check('realtimeTransport', transportReady ? 'ready' : livekitStatus, transportReady, false, transportReady ? 'realtime transport is configured' : 'realtime call transport is degraded; text/context routes remain available'),
    paymentDependency: check('paymentDependency', paymentRpcStatus === 'ready' && verifierStatus === 'fresh' ? 'ready' : 'degraded', paymentRpcStatus === 'ready' && verifierStatus === 'fresh', false, paymentRpcStatus === 'ready' && verifierStatus === 'fresh' ? 'payment verification dependency is healthy' : 'payment verification is degraded; collaboration remains available and settlement state is not inferred'),
    indexerDependency: check('indexerDependency', indexerStatus === 'ready' ? 'ready' : 'degraded', indexerStatus === 'ready', false, indexerStatus === 'ready' ? 'indexer is available' : 'indexer is degraded; collaboration remains available')
  }
  const blocking = Object.values(checks).filter((item) => item.blocksCollaboration)
  const collaborationAvailable = blocking.length === 0
  const degraded = Object.values(checks).some((item) => !item.ready)
  const status = !collaborationAvailable ? 'blocked' : degraded ? 'degraded' : 'ready'
  return {
    status,
    ready: collaborationAvailable,
    collaborationAvailable,
    mode: collaborationAvailable && checks.paymentDependency.ready ? 'collaboration_and_payment_ready' : collaborationAvailable ? 'collaboration_available_payment_degraded' : 'collaboration_blocked',
    checks,
    paymentStateAuthority: 'verifier_and_ledger_only',
    settlementAuthority: false,
    paymentStateMayBeStale: !checks.paymentDependency.ready,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    asOf: now.toISOString()
  }
}

export { normalizeStatus }
