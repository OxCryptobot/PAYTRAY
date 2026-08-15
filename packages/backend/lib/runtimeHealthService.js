function percentile(values, rank) {
  if (!values.length) return null
  const sorted = [...values].map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return null
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))
  return sorted[index]
}

function check(name, ready, reason, evidence = null) {
  return { name, ready: Boolean(ready), reason, evidence }
}

export function buildRuntimeHealthReport({
  requestMetrics = {},
  readiness = null,
  collaboration = null,
  verifierOperations = null,
  outboxHealth = null,
  webhookInboxHealth = null,
  telemetryHealth = null,
  databaseStatus = 'unknown',
  observability = {},
  now = new Date()
} = {}) {
  const totalRequests = Number(requestMetrics.total || 0)
  const errors = Number(requestMetrics.errors || 0)
  const sampleCount = Array.isArray(requestMetrics.latencies) ? requestMetrics.latencies.length : 0
  const availabilityPct = totalRequests > 0 ? Number((((totalRequests - errors) / totalRequests) * 100).toFixed(4)) : null
  const p95LatencyMs = percentile(Array.isArray(requestMetrics.latencies) ? requestMetrics.latencies : [], 95)
  const minSamples = Number.isInteger(observability.minSamples) ? observability.minSamples : 3
  const availabilityTargetPct = Number(observability.availabilityTargetPct || 99)
  const p95LatencyTargetMs = Number(observability.p95LatencyTargetMs || 800)
  const enoughSamples = totalRequests >= minSamples && sampleCount >= minSamples
  const checks = [
    check('apiAvailability', enoughSamples && availabilityPct >= availabilityTargetPct, enoughSamples ? `API availability ${availabilityPct}% must meet ${availabilityTargetPct}% target` : `at least ${minSamples} request samples are required`, { totalRequests, errors, availabilityPct, targetPct: availabilityTargetPct, minSamples }),
    check('apiLatency', enoughSamples && p95LatencyMs <= p95LatencyTargetMs, enoughSamples ? `API p95 latency ${p95LatencyMs}ms must be at or below ${p95LatencyTargetMs}ms` : `at least ${minSamples} latency samples are required`, { sampleCount, p95LatencyMs, targetMs: p95LatencyTargetMs, minSamples }),
    check('database', databaseStatus === 'ready' && readiness?.checks?.database?.ready === true, databaseStatus === 'ready' ? 'database is ready' : 'database is not ready', { databaseStatus }),
    check('collaboration', collaboration?.collaborationAvailable === true, collaboration?.collaborationAvailable === true ? 'collaboration remains available' : 'collaboration is blocked', collaboration || null),
    check('verifier', verifierOperations?.status === 'ready', verifierOperations?.status === 'ready' ? 'verifier operations are fresh and linked' : verifierOperations?.reason || 'verifier operations are unavailable or stale'),
    check('outbox', outboxHealth?.status === 'ok', outboxHealth?.status === 'ok' ? 'outbox delivery health is clean' : 'outbox delivery needs attention', outboxHealth || null),
    check('webhookInbox', webhookInboxHealth?.status === 'ok', webhookInboxHealth?.status === 'ok' ? 'webhook inbox health is clean' : 'webhook inbox needs attention', webhookInboxHealth || null),
    check('telemetry', telemetryHealth?.status !== 'error', telemetryHealth?.status ? `telemetry status is ${telemetryHealth.status}` : 'telemetry health is unavailable', telemetryHealth || null)
  ]
  const ready = checks.every((item) => item.ready)
  return {
    status: ready ? 'ok' : 'degraded',
    ready,
    generatedAt: now.toISOString(),
    slo: {
      availabilityTargetPct,
      p95LatencyTargetMs,
      minSamples,
      observed: { totalRequests, errors, sampleCount, availabilityPct, p95LatencyMs }
    },
    checks,
    blockers: checks.filter((item) => !item.ready).map(({ name, reason }) => ({ name, reason })),
    paymentStateAuthority: 'verifier_and_ledger_only',
    settlementAuthority: false,
    releaseEligible: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { percentile }
