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
  'verifier-cursor-evidence',
  'release-approval',
  'release-manifest',
  'release-payload',
  'advisory-ai',
  'token-metadata',
  'deployment-preflight',
  'smoke-phase2',
  'outbox-health',
  'idempotency-cleanup',
  'operator-key-custody',
  'secret-manager-custody'
])

const CLEARANCE_CRITERIA = Object.freeze({
  migrations: 'Ready target PostgreSQL with all repository migrations applied and schema contracts passing.',
  recovery: 'Protected custom-format backup restored into a distinct isolated database with migration and catalog verification; RECOVERY_TARGET_ISOLATED=true.',
  'railway-trial': 'Authenticated redacted Railway settings with HTTPS service origin, matching environment/policy fields, Base Sepolia selected, and mainnet disabled.',
  'verifier-operations': 'Target PostgreSQL is ready, the HTTPS Base Sepolia RPC is configured, the verifier worker has completed a durable poll, the cursor is fresh, and chain evidence is linked.',
  'verifier-cursor-evidence': 'A redacted verifier-operations report is ready for chain ID 84532 with verifierStatus.status=fresh, valid cursor block/timestamp metadata, and unlinkedEvidenceCount=0.',
  'outbox-health': 'Target PostgreSQL is ready and outbox health is ok with no dead-letter or retry attention; durable worker configuration is ready.',
  'idempotency-cleanup': 'IDEMPOTENCY_CLEANUP_ENABLED=true on a ready target PostgreSQL database with the bounded cleanup contract passing.',
  'target-operations': 'All target preflight checks pass: deployment policy, Railway URL/settings, database, HTTPS RPC, Base Sepolia safety, verifier worker, outbox worker, and idempotency housekeeping.',
  'release-approval': 'Complete release evidence plus genuine human approval bound to the exact release commit, production scope, reviewer identity, timestamp, and rollback acknowledgement.',
  'release-evidence': 'Target operations, deployment/database readiness, fresh verifier, clean reconciliation, outbox/inbox health, zero pending shadow reviews, rollback target, four sign-offs, four reviewer attestations, and key evidence are complete.',
  'reconciliation-evidence': 'Target reconciliation runs against the fresh verifier cursor and reports zero unresolved lifecycle, finality, projection-lag, ledger-linkage, and unlinked-chain-evidence issues.',
  'release-manifest': 'Exact commit is valid, worktree is clean, settlement policy is safe, and every required runtime artifact has a valid SHA-256 hash.',
  'release-payload': 'Approval is genuinely approved, manifest/migration/recovery/Railway evidence is ready, and the canonical Ed25519-signed payload verifies without tampering.',
  'operator-key-custody': 'Ephemerally injected Ed25519 key pair derives the supplied public key and expected fingerprint, with matching approved custody manifest and security-role EIP-191 fingerprint attestation.',
  'secret-manager-custody': 'Exact release commit, protected approved-secret-manager version, ephemeral key injection, non-secret custody manifest, matching fingerprint, and privateKeyExported=false are independently verified.',
  'advisory-ai': 'Advisory provider is enabled/configured with bounded retrieval and budget behavior, raw content persistence disabled, human review required, and promotion remaining shadow-only.',
  'token-metadata': 'HTTPS RPC is available on Base Sepolia and every enabled token registry entry matches on-chain chain ID, symbol, decimals, and address metadata.',
  'smoke-phase2': 'Isolated non-production smoke database, Base Sepolia policy, enabled token, and complete controlled discovery-to-outcome flow pass with chainTransactionSubmitted=false and settlementMutationPerformed=false.'
})

export function getOperationsCheckClearanceCriteria(name) {
  return CLEARANCE_CRITERIA[name] || null
}

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
    clearanceCriteria: getOperationsCheckClearanceCriteria(name),
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
    operatorBlockers: operatorBlockers.map(({ name, status, reason, clearanceCriteria }) => ({ name, status, reason, clearanceCriteria: clearanceCriteria || getOperationsCheckClearanceCriteria(name) })),
    unexpectedFailures: unexpectedFailures.map(({ name, status, reason, clearanceCriteria }) => ({ name, status, reason, clearanceCriteria: clearanceCriteria || getOperationsCheckClearanceCriteria(name) })),
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
