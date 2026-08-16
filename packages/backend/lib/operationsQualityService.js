const EXPECTED_BLOCKED_CHECKS = new Set([
  'verifier-worker-config',
  'target-operations',
  'release-evidence',
  'reconciliation-evidence',
  'unified-evidence',
  'evidence-bundle',
  'release-gates',
  'railway-trial',
  'recovery',
  'verifier-operations',
  'release-approval',
  'release-manifest',
  'release-payload',
  'advisory-ai',
  'token-metadata',
  'deployment-preflight',
  'smoke-phase2',
  'outbox-health',
  'idempotency-cleanup',
  'release-manifest',
  'release-payload',
  'operator-key-custody'
])

export function classifyOperationsCheck({ name, exitCode, output = '', strict = false } = {}) {
  const raw = String(output || '')
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const statuses = [
    parsed?.status,
    parsed?.bundle?.status,
    parsed?.evidence?.status,
    parsed?.manifest?.status,
    parsed?.payload?.status,
    parsed?.artifact?.status,
    parsed?.payload?.manifest?.status,
    parsed?.payload?.evidence?.status,
    parsed?.payload?.evidence?.manifest?.status,
    parsed?.evidence?.manifest?.status
  ].filter(Boolean)
  const status = statuses.find((value) => ['blocked', 'operator_blocked', 'settings_unavailable', 'not_ready', 'attention', 'unparseable'].includes(value)) || statuses[0] || 'unparseable'
  const infrastructureBlocked = name === 'migrations' && /(DATABASE_URL|actual.*unconfigured|PostgreSQL|ECONNREFUSED|ready.*unconfigured)/i.test(raw)
  const blockedStatus = ['blocked', 'operator_blocked', 'settings_unavailable', 'not_ready', 'attention', 'unparseable'].includes(status)
  const expectedBlocked = (EXPECTED_BLOCKED_CHECKS.has(name) || infrastructureBlocked) && blockedStatus && (exitCode !== 0 || status === 'operator_blocked')
  const state = expectedBlocked && !strict ? 'operator_blocked' : exitCode === 0 ? 'passed' : 'failed'
  return {
    name,
    state,
    exitCode,
    status,
    expectedBlocked,
    reason: parsed?.reason || (infrastructureBlocked ? 'database infrastructure is not configured or ready' : state === 'passed' ? 'check passed' : state === 'operator_blocked' ? 'operator evidence is required before this check can pass' : 'check failed unexpectedly'),
    authority: parsed?.authority || parsed?.bundle?.authority || parsed?.evidence?.authority || null,
    releaseEligible: parsed?.releaseEligible === true || parsed?.bundle?.releaseEligible === true || parsed?.evidence?.releaseEligible === true,
    settlementAuthority: parsed?.settlementAuthority === true || parsed?.bundle?.settlementAuthority === true || parsed?.evidence?.settlementAuthority === true,
    mutation: parsed?.mutation || parsed?.bundle?.mutation || parsed?.evidence?.mutation || null
  }
}

export function buildOperationsQualityReport({ checks = [], strict = false, generatedAt = new Date(), reportKind = 'operations_quality' } = {}) {
  const normalized = Array.isArray(checks) ? checks : []
  const unexpectedFailures = normalized.filter((check) => check.state === 'failed')
  const operatorBlockers = normalized.filter((check) => check.state === 'operator_blocked')
  const passed = normalized.filter((check) => check.state === 'passed')
  return {
    status: unexpectedFailures.length > 0 ? 'failed' : operatorBlockers.length > 0 ? 'operator_blocked' : 'passed',
    reportKind: String(reportKind || 'operations_quality'),
    strict,
    checkCount: normalized.length,
    passedCount: passed.length,
    operatorBlockerCount: operatorBlockers.length,
    unexpectedFailureCount: unexpectedFailures.length,
    checks: normalized,
    operatorBlockers: operatorBlockers.map(({ name, status, reason }) => ({ name, status, reason })),
    unexpectedFailures: unexpectedFailures.map(({ name, status, reason }) => ({ name, status, reason })),
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    generatedAt: generatedAt.toISOString()
  }
}

export function isOperationsQualityExitSuccess(report) {
  return report?.status !== 'failed'
}
