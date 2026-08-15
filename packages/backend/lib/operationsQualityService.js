const EXPECTED_BLOCKED_CHECKS = new Set([
  'verifier-worker-config',
  'target-operations',
  'release-evidence',
  'reconciliation-evidence',
  'unified-evidence',
  'evidence-bundle',
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
  'release-payload'
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
  const status = statuses.find((value) => ['blocked', 'settings_unavailable', 'not_ready', 'attention', 'unparseable'].includes(value)) || statuses[0] || 'unparseable'
  const infrastructureBlocked = name === 'migrations' && /(DATABASE_URL|actual.*unconfigured|PostgreSQL|ECONNREFUSED|ready.*unconfigured)/i.test(raw)
  const expectedBlocked = exitCode !== 0 && (EXPECTED_BLOCKED_CHECKS.has(name) || infrastructureBlocked) && ['blocked', 'settings_unavailable', 'not_ready', 'attention', 'unparseable'].includes(status)
  const state = exitCode === 0 ? 'passed' : expectedBlocked && !strict ? 'operator_blocked' : 'failed'
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

export function buildOperationsQualityReport({ checks = [], strict = false, generatedAt = new Date() } = {}) {
  const normalized = Array.isArray(checks) ? checks : []
  const unexpectedFailures = normalized.filter((check) => check.state === 'failed')
  const operatorBlockers = normalized.filter((check) => check.state === 'operator_blocked')
  const passed = normalized.filter((check) => check.state === 'passed')
  return {
    status: unexpectedFailures.length > 0 ? 'failed' : operatorBlockers.length > 0 ? 'operator_blocked' : 'passed',
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
