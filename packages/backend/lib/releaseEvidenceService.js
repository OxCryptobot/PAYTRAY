import { readFile } from 'node:fs/promises'
import { parseTokenRegistry } from './payments/tokenRegistry.js'
import { buildTargetOperationsPreflight } from './targetOperationsPreflight.js'
import { getReleaseReadiness } from './releaseReadiness.js'
import { buildVerifierOperationsEvidence } from './verifierOperationsEvidence.js'
import { getOutboxHealth } from './outboxDeliveryService.js'
import { getWebhookInboxHealth } from './webhookInboxService.js'
import { listShadowRuns } from './shadowReviewService.js'
import { buildDurableReconciliationReport } from './payments/reconciliationService.js'
import { buildReconciliationEvidence } from './reconciliationEvidenceService.js'

function check(name, ready, reason, evidence = null) {
  return { name, ready: Boolean(ready), reason, evidence }
}

function summarizeSignoffs(signoffs = []) {
  const records = Array.isArray(signoffs) ? signoffs : []
  const approved = records.filter((record) => record?.approved === true && record?.reviewerId && record?.approvedAt && record?.scope === 'production_release' && record?.rollbackAcknowledged === true)
  return {
    required: 4,
    supplied: records.length,
    valid: approved.length,
    complete: approved.length >= 4,
    identitiesIncluded: false
  }
}

export async function loadReleaseSignoffs(filePath = process.env.RELEASE_SIGNOFFS_FILE) {
  if (!filePath) return []
  const value = JSON.parse(await readFile(filePath, 'utf8'))
  if (!Array.isArray(value)) throw new Error('RELEASE_SIGNOFFS_FILE must contain a JSON array')
  return value
}

export async function collectReleaseEvidence({ client, config, targetOperations = null, signoffs = null, signingKeyEvidencePresent = Boolean(process.env.RELEASE_SIGNING_KEY_PEM) } = {}) {
  if (!client) throw new Error('release evidence collection requires a PostgreSQL client')
  const target = targetOperations || buildTargetOperationsPreflight({ config })
  const resolvedSignoffs = signoffs || await loadReleaseSignoffs()
  const tokenRegistry = parseTokenRegistry(config.payments.tokenRegistry)
  const verifierOperations = await buildVerifierOperationsEvidence({ client, config })
  const readiness = await getReleaseReadiness({
    client,
    config,
    databaseStatus: 'ready',
    enabledTokenCount: tokenRegistry.list({ chainId: config.payments.settlementChainId, enabledOnly: true }).length,
    verifierWorkerStatus: config.verifierWorker?.enabled ? 'configured' : 'not_configured'
  })
  const outboxHealth = await getOutboxHealth({ client, maxAttempts: config.webhooks.maxAttempts })
  const webhookInboxHealth = await getWebhookInboxHealth({ client })
  const shadowQueue = await listShadowRuns({ client, reviewerDecision: 'pending', limit: 100 })
  const rollbackResult = await client.query('SELECT COUNT(*)::int AS count FROM ai_evaluation_runs WHERE rollback_target IS NOT NULL')
  return buildReleaseEvidenceBundle({
    targetOperations: target,
    deploymentPreflight: target.deployment,
    readiness,
    verifierOperations,
    reconciliation: verifierOperations.reconciliation,
    outboxHealth,
    webhookInboxHealth,
    pendingShadowReviews: shadowQueue.count,
    rollbackTargets: rollbackResult.rows[0]?.count || 0,
    signoffs: resolvedSignoffs,
    signingKeyEvidencePresent
  })
}

export async function collectReconciliationEvidence({ client, config, gitCommit = process.env.RELEASE_GIT_COMMIT || null } = {}) {
  if (!client) throw new Error('reconciliation evidence collection requires a PostgreSQL client')
  const report = await buildDurableReconciliationReport({
    client,
    maxProjectionLagMs: config.payments.reconciliationLagThresholdMs
  })
  return buildReconciliationEvidence({ report, gitCommit })
}

export function buildReleaseEvidenceBundle({
  targetOperations = null,
  deploymentPreflight = null,
  readiness = null,
  verifierOperations = null,
  reconciliation = null,
  outboxHealth = null,
  webhookInboxHealth = null,
  pendingShadowReviews = 0,
  rollbackTargets = 0,
  signoffs = [],
  signingKeyEvidencePresent = false
} = {}) {
  const signoffSummary = summarizeSignoffs(signoffs)
  const checks = [
    check('targetOperations', targetOperations?.status === 'ready', targetOperations?.status === 'ready' ? 'target configuration checks passed' : 'target configuration evidence is blocked or unavailable', { status: targetOperations?.status || 'not_provided', releaseEligible: targetOperations?.releaseEligible === true }),
    check('deploymentPreflight', deploymentPreflight?.ready === true, deploymentPreflight?.ready ? 'deployment configuration preflight passed' : 'deployment configuration requires attention'),
    check('database', readiness?.checks?.database?.ready === true, readiness?.checks?.database?.ready ? 'database readiness evidence passed' : 'database readiness evidence is unavailable'),
    check('verifierOperations', verifierOperations?.status === 'ready', verifierOperations?.status === 'ready' ? 'verifier operations evidence is fresh and linked' : verifierOperations?.reason || 'verifier operations evidence is not ready'),
    check('reconciliation', (reconciliation || verifierOperations?.reconciliation)?.status === 'ok', (reconciliation || verifierOperations?.reconciliation)?.status === 'ok' ? 'reconciliation evidence is clean' : 'reconciliation evidence requires attention'),
    check('outbox', outboxHealth?.status === 'ok', outboxHealth?.status === 'ok' ? 'durable outbox has no dead-letter attention' : 'durable outbox evidence is unavailable or requires attention'),
    check('webhookInbox', webhookInboxHealth?.status === 'ok', webhookInboxHealth?.status === 'ok' ? 'webhook inbox has no quarantine or due attention' : 'webhook inbox evidence is unavailable or requires attention'),
    check('shadowReviews', Number(pendingShadowReviews) === 0, Number(pendingShadowReviews) === 0 ? 'no pending shadow reviews reported' : 'pending shadow reviews remain', { pendingShadowReviews: Number(pendingShadowReviews) }),
    check('rollbackTargets', Number(rollbackTargets) > 0, Number(rollbackTargets) > 0 ? 'rollback target evidence is present' : 'rollback target evidence is missing', { rollbackTargets: Number(rollbackTargets) }),
    check('humanSignoffs', signoffSummary.complete, signoffSummary.complete ? 'four valid human sign-offs supplied' : 'four valid human sign-offs are required', signoffSummary),
    check('signingKey', signingKeyEvidencePresent === true, signingKeyEvidencePresent ? 'operator signing-key presence was reported without exposing key material' : 'operator signing-key evidence is not present')
  ]
  const evidenceComplete = checks.every((item) => item.ready)
  return {
    status: evidenceComplete ? 'evidence_complete_pending_release_gate' : 'blocked',
    evidenceComplete,
    releaseEligible: false,
    approvalRequired: true,
    promotionStatus: 'shadow_only',
    authority: 'release_evidence_aggregation_only',
    mutation: 'read_only',
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    checks,
    blockers: checks.filter((item) => !item.ready).map(({ name, reason }) => ({ name, reason })),
    signoffSummary,
    signingKeyMaterialIncluded: false,
    generatedAt: new Date().toISOString()
  }
}
