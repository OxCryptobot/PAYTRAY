import { lstat, readFile } from 'node:fs/promises'
import { parseTokenRegistry } from './payments/tokenRegistry.js'
import { buildTargetOperationsPreflight } from './targetOperationsPreflight.js'
import { getReleaseReadiness } from './releaseReadiness.js'
import { buildVerifierOperationsEvidence } from './verifierOperationsEvidence.js'
import { getOutboxHealth } from './outboxDeliveryService.js'
import { getWebhookInboxHealth } from './webhookInboxService.js'
import { listShadowRuns } from './shadowReviewService.js'
import { buildDurableReconciliationReport } from './payments/reconciliationService.js'
import { buildReconciliationEvidence } from './reconciliationEvidenceService.js'
import { buildEvidenceFingerprint } from './evidenceFingerprint.js'
import { listReviewerAttestations, REVIEWER_ROLES } from './reviewerAttestationService.js'

function check(name, ready, reason, evidence = null) {
  return { name, ready: Boolean(ready), reason, evidence }
}

const REQUIRED_SIGNOFF_ROLES = ['release_operator', 'protocol_finance', 'ai_data', 'security']

function summarizeSignoffs(signoffs = []) {
  const records = Array.isArray(signoffs) ? signoffs : []
  const approved = records.filter((record) => record?.approved === true && record?.reviewerId && record?.approvedAt && !Number.isNaN(Date.parse(record.approvedAt)) && record?.scope === 'production_release' && record?.rollbackAcknowledged === true && REQUIRED_SIGNOFF_ROLES.includes(record?.role))
  const rolesPresent = [...new Set(approved.map((record) => record.role))]
  const missingRoles = REQUIRED_SIGNOFF_ROLES.filter((role) => !rolesPresent.includes(role))
  return {
    required: REQUIRED_SIGNOFF_ROLES.length,
    requiredRoles: REQUIRED_SIGNOFF_ROLES,
    supplied: records.length,
    valid: approved.length,
    rolesPresent,
    missingRoles,
    complete: missingRoles.length === 0,
    identitiesIncluded: false
  }
}

function summarizeReviewerAttestations({ attestations = [], releaseCommit = null } = {}) {
  const records = Array.isArray(attestations) ? attestations : []
  const normalizedCommit = typeof releaseCommit === 'string' ? releaseCommit.trim().toLowerCase() : null
  const matching = records.filter((record) => record?.release_commit?.trim?.().toLowerCase?.() === normalizedCommit && REVIEWER_ROLES.includes(record?.role) && record?.reviewer_wallet && record?.attestation_digest && record?.decision === 'approved' && record?.applied === false && record?.release_eligible === false && record?.settlement_authority === false && record?.mutation === 'read_only')
  const rolesPresent = [...new Set(matching.map((record) => record.role))]
  const missingRoles = REVIEWER_ROLES.filter((role) => !rolesPresent.includes(role))
  const duplicateRoles = REVIEWER_ROLES.filter((role) => matching.filter((record) => record.role === role).length > 1)
  const rejectedRoles = [...new Set(records.filter((record) => record?.release_commit?.trim?.().toLowerCase?.() === normalizedCommit && REVIEWER_ROLES.includes(record?.role) && record?.decision === 'rejected').map((record) => record.role))]
  return {
    required: REVIEWER_ROLES.length,
    requiredRoles: REVIEWER_ROLES,
    releaseCommit: normalizedCommit,
    supplied: records.length,
    valid: matching.length,
    rolesPresent,
    missingRoles,
    duplicateRoles,
    rejectedRoles,
    complete: Boolean(normalizedCommit) && missingRoles.length === 0 && duplicateRoles.length === 0 && rejectedRoles.length === 0,
    identitiesIncluded: false,
    signatureBytesIncluded: false
  }
}

function buildSigningKeyEvidence({ present = false, publicKeyFingerprintSha256 = null, independentlyVerified = false } = {}) {
  const fingerprint = typeof publicKeyFingerprintSha256 === 'string' ? publicKeyFingerprintSha256.trim().toLowerCase() : null
  const validFingerprint = /^[a-f0-9]{64}$/.test(fingerprint || '')
  return {
    present: present === true,
    publicKeyFingerprintSha256: validFingerprint ? fingerprint : null,
    fingerprintProvided: validFingerprint,
    independentlyVerified: independentlyVerified === true,
    ready: present === true && validFingerprint && independentlyVerified === true,
    source: 'operator_supplied_non_secret_key_evidence'
  }
}

async function assertRegularNonSymlinkFile(filePath, label) {
  let stats
  try {
    stats = await lstat(filePath)
  } catch (error) {
    throw new Error(`${label} cannot be inspected: ${error.message}`, { cause: error })
  }
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink`)
  if (!stats.isFile()) throw new Error(`${label} must be a regular file`)
}

export async function loadReleaseSignoffs(filePath = process.env.RELEASE_SIGNOFFS_FILE) {
  if (!filePath) return []
  await assertRegularNonSymlinkFile(filePath, 'RELEASE_SIGNOFFS_FILE')
  const value = JSON.parse(await readFile(filePath, 'utf8'))
  if (!Array.isArray(value)) throw new Error('RELEASE_SIGNOFFS_FILE must contain a JSON array')
  return value
}

export async function collectReleaseEvidence({ client, config, targetOperations = null, signoffs = null, signingKeyEvidence = null } = {}) {
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
  const releaseCommit = process.env.RELEASE_GIT_COMMIT || null
  const reviewerAttestationRecords = releaseCommit ? await listReviewerAttestations({ client, releaseCommit }) : { attestations: [] }
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
    reviewerAttestationSummary: summarizeReviewerAttestations({ attestations: reviewerAttestationRecords.attestations, releaseCommit }),
    signoffs: resolvedSignoffs,
    releaseCommit,
    signingKeyEvidence: signingKeyEvidence || buildSigningKeyEvidence({
      present: Boolean(process.env.RELEASE_SIGNING_KEY_PEM),
      publicKeyFingerprintSha256: process.env.RELEASE_SIGNING_PUBLIC_KEY_SHA256,
      independentlyVerified: process.env.RELEASE_SIGNING_PUBLIC_KEY_FINGERPRINT_VERIFIED === 'true'
    })
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

export function buildUnifiedOperatorEvidence({ releaseEvidence = null, reconciliationEvidence = null } = {}) {
  const reconciliationVerified = reconciliationEvidence?.status === 'verified'
  const evidenceComplete = releaseEvidence?.evidenceComplete === true && reconciliationVerified
  const evidenceFingerprint = buildEvidenceFingerprint({
    kind: 'operator_evidence',
    content: {
      releaseEvidenceFingerprint: releaseEvidence?.evidenceFingerprint?.value || null,
      reconciliationEvidenceHash: reconciliationEvidence?.evidenceHash || null,
      releaseEvidenceComplete: releaseEvidence?.evidenceComplete === true,
      reconciliationVerified,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only'
    }
  })
  return {
    status: evidenceComplete ? 'complete_pending_release_gate' : 'blocked',
    evidenceComplete,
    releaseEligible: false,
    authority: 'operator_evidence_aggregation_only',
    mutation: 'read_only',
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    evidenceFingerprint,
    releaseEvidence,
    reconciliationEvidence,
    blockers: [
      ...(releaseEvidence?.blockers || []),
      ...(reconciliationVerified ? [] : [{ name: 'reconciliation', reason: 'reconciliation evidence is not verified' }])
    ]
  }
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
  reviewerAttestationSummary = null,
  signoffs = [],
  signingKeyEvidence = null,
  releaseCommit = process.env.RELEASE_GIT_COMMIT || null
} = {}) {
  const signoffSummary = summarizeSignoffs(signoffs)
  const attestationSummary = reviewerAttestationSummary || summarizeReviewerAttestations()
  const keyEvidence = buildSigningKeyEvidence(signingKeyEvidence || {})
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
    check('humanSignoffs', signoffSummary.complete, signoffSummary.complete ? 'four required human sign-off roles supplied' : `required human sign-off roles are missing: ${signoffSummary.missingRoles.join(', ')}`, signoffSummary),
    check('reviewerAttestations', attestationSummary.complete, attestationSummary.complete ? 'four cryptographically verified reviewer attestations are bound to the release commit' : `verified reviewer attestations are incomplete for the release commit: ${attestationSummary.missingRoles.join(', ')}`, attestationSummary),
    check('signingKey', keyEvidence.ready, keyEvidence.ready ? 'operator key presence, public-key fingerprint, and independent fingerprint verification were reported without exposing key material' : 'operator key, public-key fingerprint, and independent fingerprint verification are all required', keyEvidence)
  ]
  const evidenceComplete = checks.every((item) => item.ready)
  const evidenceFingerprint = buildEvidenceFingerprint({
    kind: 'release_evidence',
    content: {
      releaseCommit,
      checks,
      signoffSummary,
      reviewerAttestationSummary: attestationSummary,
      signingKeyEvidence: { ...keyEvidence, publicKeyFingerprintSha256: keyEvidence.publicKeyFingerprintSha256 },
      signingKeyMaterialIncluded: false,
      authority: 'release_evidence_aggregation_only',
      mutation: 'read_only',
      settlementAuthority: false,
      releaseEligible: false
    }
  })
  return {
    status: evidenceComplete ? 'evidence_complete_pending_release_gate' : 'blocked',
    releaseCommit,
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
    reviewerAttestationSummary: attestationSummary,
    signingKeyEvidence: { ...keyEvidence, publicKeyFingerprintSha256: keyEvidence.publicKeyFingerprintSha256 },
    signingKeyMaterialIncluded: false,
    evidenceFingerprint,
    generatedAt: new Date().toISOString()
  }
}
