import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import helmet from 'helmet'
import crypto from 'crypto'

import config, { validateConfig } from './lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from './lib/database.js'
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  schemas,
  validate
} from './lib/errors.js'
import { getLogger, requestLogger, errorLogger } from './lib/logger.js'
import { loadStateSnapshot, saveStateSnapshot } from './lib/stateStore.js'
import { parseTokenRegistry } from './lib/payments/tokenRegistry.js'
import {
  createPaymentIntentV2,
  getPaymentIntentV2,
  listPaymentStreamsV2
} from './lib/payments/paymentApiService.js'
import { buildReadinessReport } from './lib/health.js'
import { searchExperts } from './lib/discoveryService.js'
import { recordDiscoveryImpressions } from './lib/discoveryImpressionService.js'
import {
  attachPaymentIntentToEngagement,
  createEngagementContext,
  getEngagementContext,
  getEngagementPaymentState,
  updateCollaborationState
} from './lib/engagementService.js'
import { getPilotMetrics, recordOutcome, verifyOutcome } from './lib/outcomeService.js'
import { listVerifiedTrustSignals } from './lib/trustSignalService.js'
import { ingestTelemetryEvent } from './lib/telemetryService.js'
import { processVerifiedChainEvent } from './lib/payments/verifiedEventService.js'
import { getTelemetryHealth } from './lib/telemetryObservability.js'
import { getReleaseReadiness } from './lib/releaseReadiness.js'
import { buildReleaseApprovalArtifact } from './lib/releaseApprovalGate.js'
import { buildDeploymentPreflight } from './lib/deploymentPreflight.js'
import { getShadowRunDetails, listShadowRuns, reviewShadowRun } from './lib/shadowReviewService.js'
import { buildDurableReconciliationReport } from './lib/payments/reconciliationService.js'
import { createConfiguredBaseSepoliaVerifierWorker } from './lib/payments/verifierWorkerService.js'
import { assertSafeWebhookUrl, validateWebhookUrl } from './lib/webhookSecurity.js'
import { createWebhookSignatureHeader } from './lib/webhookSignature.js'
import { getFinancialSummary, getVerifierObservability } from './lib/verifierObservability.js'
import { listFinancialAuditEvents } from './lib/auditLogService.js'
import { listDiscoveryOutcomeLineage } from './lib/discoveryLineageService.js'
import { buildVerifierOperationsEvidence } from './lib/verifierOperationsEvidence.js'
import { getOutboxHealth, listOutboxEvents } from './lib/outboxDeliveryService.js'
import { processDurableOutbox } from './lib/outboxProcessorService.js'
import { createAdvisoryAiRequest, getAdvisoryAiCapabilities, runBoundedAdvisory } from './lib/advisoryAiBoundary.js'
import { buildCollaborationHealth } from './lib/collaborationHealth.js'
import { buildRuntimeHealthReport } from './lib/runtimeHealthService.js'
import { buildOperatorHealthDashboard } from './lib/operatorHealthDashboard.js'
import { getLatestReleaseGatesRun, getOperationsQualityRun, listOperationsQualityRuns } from './lib/operationsQualityAuditService.js'
import { buildOperatorEvidenceBundle } from './lib/operatorEvidenceBundleService.js'
import { collectReleaseEvidence, collectReconciliationEvidence, buildUnifiedOperatorEvidence } from './lib/releaseEvidenceService.js'
import { getExtensionContractCapabilities, normalizeExtensionHookInput, projectExtensionPayload } from './lib/extensionContracts.js'
import { getExtensionOpenApiDocument } from './lib/extensionOpenApi.js'
import { listExtensionHooks, registerExtensionHook } from './lib/extensionHookService.js'
import { getWebhookInboxHealth } from './lib/webhookInboxService.js'
import { assertLegacyPaymentMutationAllowed } from './lib/payments/legacyPaymentPolicy.js'
import {
  generateServiceToken,
  generateTokenPair,
  verifyToken,
  verifyWalletSignature,
  checkRateLimit,
  getClientIP
} from './lib/security.js'

dotenv.config({ path: '.env.local' })

const logger = getLogger('Server')
const app = express()
app.locals.advisoryAiProvider = null
const profiles = new Map()
const paymentStreams = new Map()
const calls = new Map()
const matchSessions = new Map()
const conversationThreads = new Map()
const engagementContracts = new Map()
const reputationEvents = []
const RANKING_WEIGHTS = Object.freeze({
  skillMatch: 0.3,
  budgetScore: 0.15,
  timezoneScore: 0.1,
  languageScore: 0.1,
  chainScore: 0.1,
  completionRate: 0.15,
  outcomeHistoryBoost: 0.1
})

const rankingModel = {
  version: 1,
  trainedAt: null,
  expertiseScores: {},
  weights: RANKING_WEIGHTS,
  evaluation: {
    sampleSize: 0,
    metrics: {
      completionPaidRate: 0,
      disputedRate: 0,
      repeatBookingRate: 0,
      avgPaidMinutes: 0,
      skillCoverage: 0
    }
  }
}
const chainRegistry = new Map([[String(config.payments.settlementChainId), { enabled: true, reason: 'default settlement chain' }]])
const paymentTokenRegistry = parseTokenRegistry(config.payments.tokenRegistry)
const paymentCreateIdempotency = new Map()
const queueJobs = new Map()
const extensionHooks = new Map()
const webhookDeliveries = new Map()
const authChallenges = new Map()
const walletVerifyChallenges = new Map()
const trustSignals = new Map()
const offchainLedger = new Map()
const identityLinks = new Map()
const sessionArtifacts = new Map()
const requestMetrics = {
  total: 0,
  errors: 0,
  latencies: [],
  auth: {
    challengesIssued: 0,
    challengeRateLimited: 0,
    loginSuccess: 0,
    loginFailed: 0,
    loginRateLimited: 0
  },
  walletVerification: {
    challengesIssued: 0,
    challengeRateLimited: 0,
    verifySuccess: 0,
    verifyFailed: 0,
    verifyRateLimited: 0
  }
}

let stateDirty = false
let stateFlushTimer = null

function nowIso() {
  return new Date().toISOString()
}

function hasScope(userScopes, requiredScope) {
  if (userScopes.includes('*')) {
    return true
  }

  if (userScopes.includes(requiredScope)) {
    return true
  }

  const [requiredPrefix] = requiredScope.split(':')
  return userScopes.includes(`${requiredPrefix}:*`)
}

function getDefaultScopes(walletAddress) {
  const baseScopes = [
    'profile:*',
    'payments:*',
    'threads:*',
    'discovery:*',
    'reputation:*',
    'intelligence:*',
    'extensions:*'
  ]

  const normalizedWallet = walletAddress.toLowerCase()
  const isAdmin = config.auth.adminWallets.includes(normalizedWallet)
  const isOperator = isAdmin || config.auth.operatorWallets.includes(normalizedWallet)

  if (isOperator) {
    return [...baseScopes, 'ops:*', ...(isAdmin ? ['admin:*'] : [])]
  }

  return baseScopes
}

function resolveLoginScopes(defaultScopes, requestedScopesRaw) {
  if (requestedScopesRaw == null) {
    return defaultScopes
  }

  if (!Array.isArray(requestedScopesRaw)) {
    throw new ValidationError('Requested scopes must be an array')
  }

  const requestedScopes = [...new Set(requestedScopesRaw.map((scope) => {
    if (typeof scope !== 'string') {
      throw new ValidationError('Requested scopes must contain only strings')
    }

    const normalized = scope.trim()
    if (!normalized) {
      throw new ValidationError('Requested scopes must not contain empty values')
    }

    return normalized
  }))]

  if (requestedScopes.length === 0) {
    throw new ValidationError('Requested scopes must include at least one scope')
  }

  for (const scope of requestedScopes) {
    if (!hasScope(defaultScopes, scope)) {
      throw new AuthorizationError(`Requested scope is not allowed: ${scope}`)
    }
  }

  return requestedScopes
}

function requireScopes(...requiredScopes) {
  return (req, res, next) => {
    const grantedScopes = safeArray(req.scopes)
    const missing = requiredScopes.filter((scope) => !hasScope(grantedScopes, scope))

    if (missing.length > 0) {
      return next(new AuthorizationError(`Missing required scopes: ${missing.join(', ')}`))
    }

    return next()
  }
}

function markStateDirty() {
  stateDirty = true
}

function serializeState() {
  return {
    version: 1,
    updatedAt: nowIso(),
    profiles: Array.from(profiles.entries()),
    paymentStreams: Array.from(paymentStreams.entries()),
    calls: Array.from(calls.entries()),
    matchSessions: Array.from(matchSessions.entries()),
    conversationThreads: Array.from(conversationThreads.entries()),
    engagementContracts: Array.from(engagementContracts.entries()),
    trustSignals: Array.from(trustSignals.entries()),
    offchainLedger: Array.from(offchainLedger.entries()),
    identityLinks: Array.from(identityLinks.entries()),
    sessionArtifacts: Array.from(sessionArtifacts.entries()),
    reputationEvents,
    rankingModel,
    chainRegistry: Array.from(chainRegistry.entries()),
    paymentCreateIdempotency: Array.from(paymentCreateIdempotency.entries()),
    queueJobs: Array.from(queueJobs.entries()),
    extensionHooks: Array.from(extensionHooks.entries()),
    webhookDeliveries: Array.from(webhookDeliveries.entries())
  }
}

function restoreState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return
  }

  for (const [key, value] of safeArray(snapshot.profiles)) profiles.set(key, value)
  for (const [key, value] of safeArray(snapshot.paymentStreams)) paymentStreams.set(key, value)
  for (const [key, value] of safeArray(snapshot.calls)) calls.set(key, value)
  for (const [key, value] of safeArray(snapshot.matchSessions)) matchSessions.set(key, value)
  for (const [key, value] of safeArray(snapshot.conversationThreads)) conversationThreads.set(key, value)
  for (const [key, value] of safeArray(snapshot.engagementContracts)) engagementContracts.set(key, value)
  for (const [key, value] of safeArray(snapshot.trustSignals)) trustSignals.set(key, value)
  for (const [key, value] of safeArray(snapshot.offchainLedger)) offchainLedger.set(key, value)
  for (const [key, value] of safeArray(snapshot.identityLinks)) identityLinks.set(key, value)
  for (const [key, value] of safeArray(snapshot.sessionArtifacts)) sessionArtifacts.set(key, value)
  for (const value of safeArray(snapshot.reputationEvents)) reputationEvents.push(value)

  if (snapshot.rankingModel && typeof snapshot.rankingModel === 'object') {
    rankingModel.version = Number(snapshot.rankingModel.version || rankingModel.version)
    rankingModel.trainedAt = snapshot.rankingModel.trainedAt || null
    rankingModel.expertiseScores = snapshot.rankingModel.expertiseScores || {}
    rankingModel.weights = snapshot.rankingModel.weights || rankingModel.weights
    rankingModel.evaluation = snapshot.rankingModel.evaluation || rankingModel.evaluation
  }

  chainRegistry.clear()
  const restoredChains = safeArray(snapshot.chainRegistry)
  if (restoredChains.length) {
    for (const [key, value] of restoredChains) chainRegistry.set(key, value)
  } else {
    chainRegistry.set(String(config.payments.settlementChainId), { enabled: true, reason: 'default settlement chain' })
  }

  for (const [key, value] of safeArray(snapshot.queueJobs)) queueJobs.set(key, value)
  for (const [key, value] of safeArray(snapshot.paymentCreateIdempotency)) paymentCreateIdempotency.set(key, value)
  for (const [key, value] of safeArray(snapshot.extensionHooks)) extensionHooks.set(key, value)
  for (const [key, value] of safeArray(snapshot.webhookDeliveries)) webhookDeliveries.set(key, value)
}

async function flushStateSnapshot(force = false) {
  if (!force && !stateDirty) {
    return false
  }

  await saveStateSnapshot(config.state.filePath, serializeState())
  stateDirty = false
  return true
}

async function enqueueWebhookDeliveries(eventName, payload) {
  const hooks = Array.from(extensionHooks.values()).filter((hook) => hook.event === eventName)

  for (const hook of hooks) {
    const id = String(webhookDeliveries.size + 1)
    webhookDeliveries.set(id, {
      id,
      hookId: hook.id,
      event: eventName,
      callbackUrl: hook.callbackUrl,
      payload: hook.apiVersion === 'v2' ? projectExtensionPayload({ hook, payload }) : payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: config.webhooks.maxAttempts,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastError: null,
      nextAttemptAt: nowIso()
    })
  }

  if (hooks.length > 0) {
    markStateDirty()
  }
}

async function processWebhookDeliveries({ dryRun = false, canProcessDelivery = null } = {}) {
  const results = []

  for (const delivery of webhookDeliveries.values()) {
    if (!['pending', 'failed'].includes(delivery.status)) continue
    if (delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > Date.now()) continue
    if (typeof canProcessDelivery === 'function' && !canProcessDelivery(delivery)) continue

    delivery.attempts += 1
    delivery.updatedAt = nowIso()
    delivery.status = 'processing'

    try {
      const envelope = createWebhookDispatchEnvelope(delivery)
      delivery.lastSignature = envelope.signatureHeader
      delivery.lastSignatureTimestamp = envelope.timestamp

      if (!dryRun) {
        await assertSafeWebhookUrl(delivery.callbackUrl)
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), config.webhooks.timeoutMs)

        try {
          const headers = {
            'content-type': 'application/json',
            'x-paytray-timestamp': envelope.timestamp
          }

          if (envelope.signatureHeader) {
            headers['x-paytray-signature'] = envelope.signatureHeader
          }

          const response = await fetch(delivery.callbackUrl, {
            method: 'POST',
            headers,
            body: envelope.body,
            signal: controller.signal
          })

          if (!response.ok) {
            throw new Error(`webhook_http_${response.status}`)
          }
        } finally {
          clearTimeout(timeout)
        }
      }

      delivery.status = 'delivered'
      delivery.lastError = null
      delivery.nextAttemptAt = null
      results.push({ id: delivery.id, status: delivery.status })
    } catch (error) {
      delivery.lastError = error.message
      delivery.status = delivery.attempts >= delivery.maxAttempts ? 'dead' : 'failed'
      delivery.nextAttemptAt = delivery.status === 'failed'
        ? new Date(Date.now() + (config.webhooks.retryBaseDelayMs * (2 ** Math.max(0, delivery.attempts - 1)))).toISOString()
        : null
      results.push({ id: delivery.id, status: delivery.status, error: delivery.lastError, nextAttemptAt: delivery.nextAttemptAt })
    }
  }

  if (results.length > 0) {
    markStateDirty()
  }

  return results
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function median(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function percentile(values, percentileRank) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.ceil((percentileRank / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

function getIdempotencyKey(req) {
  const raw = req.headers['x-idempotency-key']
  if (raw == null) {
    return null
  }

  if (typeof raw !== 'string') {
    throw new ValidationError('x-idempotency-key must be a string')
  }

  const key = raw.trim()
  if (!key) {
    return null
  }

  if (key.length > 128) {
    throw new ValidationError('x-idempotency-key must be 128 characters or fewer')
  }

  if (!/^[a-zA-Z0-9:_-]+$/.test(key)) {
    throw new ValidationError('x-idempotency-key contains unsupported characters')
  }

  return key
}

function fingerprintPaymentCreateRequest(senderWallet, chainId, validated) {
  return JSON.stringify({
    senderWallet: senderWallet.toLowerCase(),
    recipientWallet: validated.recipient.toLowerCase(),
    token: String(validated.token).toUpperCase(),
    amount: Number(validated.amount),
    duration: Number(validated.duration),
    chainId: Number(chainId)
  })
}

function buildAuthChallengeMessage(walletAddress, nonce, issuedAt, expiresAt) {
  return [
    'PayTray wants you to sign in with your Ethereum account:',
    walletAddress,
    '',
    'Sign in to PayTray.',
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`
  ].join('\n')
}

function cleanupExpiredAuthChallenges() {
  const now = Date.now()

  for (const [challengeId, challenge] of authChallenges.entries()) {
    if (now > challenge.expiresAtMs) {
      authChallenges.delete(challengeId)
    }
  }
}

function createAuthChallenge(walletAddress) {
  cleanupExpiredAuthChallenges()

  const challengeId = crypto.randomUUID()
  const nonce = crypto.randomBytes(16).toString('hex')
  const issuedAt = nowIso()
  const expiresAtMs = Date.now() + (config.auth.challengeTTLSeconds * 1000)
  const expiresAt = new Date(expiresAtMs).toISOString()
  const message = buildAuthChallengeMessage(walletAddress, nonce, issuedAt, expiresAt)

  const challenge = {
    id: challengeId,
    wallet: walletAddress,
    nonce,
    issuedAt,
    expiresAt,
    expiresAtMs,
    message
  }

  authChallenges.set(challengeId, challenge)
  return challenge
}

function consumeAuthChallenge(challengeId, walletAddress, message) {
  cleanupExpiredAuthChallenges()

  const challenge = authChallenges.get(challengeId)
  if (!challenge) {
    throw new AuthenticationError('Auth challenge is invalid or expired')
  }

  if (challenge.wallet !== walletAddress.toLowerCase()) {
    authChallenges.delete(challengeId)
    throw new AuthenticationError('Auth challenge wallet mismatch')
  }

  if (challenge.message !== message) {
    throw new AuthenticationError('Auth challenge message mismatch')
  }

  if (Date.now() > challenge.expiresAtMs) {
    authChallenges.delete(challengeId)
    throw new AuthenticationError('Auth challenge is invalid or expired')
  }

  authChallenges.delete(challengeId)
  return challenge
}

function buildWalletVerifyChallengeMessage(walletAddress, chainId, nonce, issuedAt, expiresAt) {
  return [
    'PayTray wallet verification challenge:',
    walletAddress,
    `Chain ID: ${chainId}`,
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expiresAt}`
  ].join('\n')
}

function cleanupExpiredWalletVerifyChallenges() {
  const now = Date.now()

  for (const [challengeId, challenge] of walletVerifyChallenges.entries()) {
    if (now > challenge.expiresAtMs) {
      walletVerifyChallenges.delete(challengeId)
    }
  }
}

function createWalletVerifyChallenge(walletAddress, chainId) {
  cleanupExpiredWalletVerifyChallenges()

  const challengeId = crypto.randomUUID()
  const nonce = crypto.randomBytes(16).toString('hex')
  const issuedAt = nowIso()
  const expiresAtMs = Date.now() + (config.auth.walletVerifyChallengeTTLSeconds * 1000)
  const expiresAt = new Date(expiresAtMs).toISOString()
  const message = buildWalletVerifyChallengeMessage(walletAddress, chainId, nonce, issuedAt, expiresAt)

  const challenge = {
    id: challengeId,
    wallet: walletAddress,
    chainId,
    nonce,
    issuedAt,
    expiresAt,
    expiresAtMs,
    message
  }

  walletVerifyChallenges.set(challengeId, challenge)
  return challenge
}

function createWebhookDispatchEnvelope(delivery) {
  const timestamp = String(Date.now())
  const bodyPayload = {
    event: delivery.event,
    eventId: String(delivery.id),
    payload: delivery.payload
  }
  const body = JSON.stringify(bodyPayload)
  return {
    timestamp,
    body,
    signatureHeader: config.webhooks.signingSecret
      ? createWebhookSignatureHeader({ timestamp, body, secret: config.webhooks.signingSecret })
      : null
  }
}

function consumeWalletVerifyChallenge(challengeId, walletAddress, message, chainId) {
  cleanupExpiredWalletVerifyChallenges()

  const challenge = walletVerifyChallenges.get(challengeId)
  if (!challenge) {
    throw new AuthenticationError('Wallet verification challenge is invalid or expired')
  }

  if (challenge.wallet !== walletAddress.toLowerCase()) {
    walletVerifyChallenges.delete(challengeId)
    throw new AuthenticationError('Wallet verification challenge wallet mismatch')
  }

  if (challenge.chainId !== chainId) {
    walletVerifyChallenges.delete(challengeId)
    throw new AuthenticationError('Wallet verification challenge chain mismatch')
  }

  if (challenge.message !== message) {
    throw new AuthenticationError('Wallet verification challenge message mismatch')
  }

  if (Date.now() > challenge.expiresAtMs) {
    walletVerifyChallenges.delete(challengeId)
    throw new AuthenticationError('Wallet verification challenge is invalid or expired')
  }

  walletVerifyChallenges.delete(challengeId)
  return challenge
}

function getSupportedVerificationChainIds() {
  return new Set([1, 10, 42161, 11155111, config.payments.settlementChainId])
}

function getDeliveryOwnerWallet(delivery) {
  const hook = extensionHooks.get(delivery.hookId)
  return hook?.ownerWallet || null
}

function canManageQueueJob(job, walletAddress, isAdmin) {
  if (isAdmin) {
    return true
  }

  return job.ownerWallet === walletAddress
}

function computeReliabilityMetrics() {
  const streamValues = Array.from(paymentStreams.values())

  if (!streamValues.length) {
    return {
      totalStreams: 0,
      reflectedStreams: 0,
      reliabilityPct: 100
    }
  }

  const reflectedStreams = streamValues.filter((stream) => stream.confirmationState === 'reflected').length
  const reliabilityPct = Number(((reflectedStreams / streamValues.length) * 100).toFixed(2))

  return {
    totalStreams: streamValues.length,
    reflectedStreams,
    reliabilityPct
  }
}

function computeOperationalBacklogMetrics() {
  const jobs = Array.from(queueJobs.values())
  const deliveries = Array.from(webhookDeliveries.values())

  const queue = {
    total: jobs.length,
    pending: jobs.filter((job) => job.status === 'pending').length,
    processing: jobs.filter((job) => job.status === 'processing').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
    dead: jobs.filter((job) => job.status === 'dead').length,
    completed: jobs.filter((job) => job.status === 'completed').length
  }

  const webhooks = {
    total: deliveries.length,
    pending: deliveries.filter((delivery) => delivery.status === 'pending').length,
    processing: deliveries.filter((delivery) => delivery.status === 'processing').length,
    failed: deliveries.filter((delivery) => delivery.status === 'failed').length,
    dead: deliveries.filter((delivery) => delivery.status === 'dead').length,
    delivered: deliveries.filter((delivery) => delivery.status === 'delivered').length
  }

  return {
    queue,
    webhooks,
    retryableQueueJobs: queue.failed + queue.dead,
    retryableWebhookDeliveries: webhooks.failed + webhooks.dead
  }
}

function buildReputationSummary(wallet) {
  const normalizedWallet = wallet.toLowerCase()
  const events = reputationEvents.filter((event) => event.wallet === normalizedWallet)
  const completed = events.filter((event) => event.outcome === 'completed').length
  const paid = events.filter((event) => event.paidMinutes > 0).length
  const disputed = events.filter((event) => event.disputed === true).length

  return {
    wallet: normalizedWallet,
    events: events.length,
    completed,
    paid,
    disputed,
    repeatBookings: events.filter((event) => event.repeatBooking === true).length
  }
}

function recomputeRankingEvaluation() {
  rankingModel.evaluation = evaluateRankingModel()
}

function getLedgerEntry(wallet, chainId) {
  const key = `${wallet.toLowerCase()}:${chainId}`
  if (!offchainLedger.has(key)) {
    offchainLedger.set(key, {
      wallet: wallet.toLowerCase(),
      chainId: Number(chainId),
      currency: 'USDC',
      pendingBalance: 0,
      settledBalance: 0,
      updatedAt: nowIso()
    })
  }
  return offchainLedger.get(key)
}

function applyLedgerDelta(wallet, chainId, { pending = 0, settled = 0 }) {
  const entry = getLedgerEntry(wallet, chainId)
  entry.pendingBalance = Math.max(0, entry.pendingBalance + pending)
  entry.settledBalance = Math.max(0, entry.settledBalance + settled)
  entry.updatedAt = nowIso()
}

function trainRankingModelFromOutcomes() {
  const totals = {}

  for (const event of reputationEvents) {
    for (const skill of safeArray(event.expertise)) {
      if (!totals[skill]) {
        totals[skill] = { completed: 0, total: 0 }
      }
      totals[skill].total += 1
      if (event.outcome === 'completed' && event.paidMinutes > 0 && event.disputed !== true) {
        totals[skill].completed += 1
      }
    }
  }

  const expertiseScores = {}
  for (const [skill, data] of Object.entries(totals)) {
    expertiseScores[skill] = Number((data.completed / data.total).toFixed(4))
  }

  rankingModel.version += 1
  rankingModel.trainedAt = nowIso()
  rankingModel.expertiseScores = expertiseScores
  rankingModel.weights = RANKING_WEIGHTS
  rankingModel.evaluation = evaluateRankingModel()

  return {
    version: rankingModel.version,
    trainedAt: rankingModel.trainedAt,
    sampleSize: reputationEvents.length,
    expertiseScores,
    evaluation: rankingModel.evaluation
  }
}

function evaluateRankingModel() {
  const totalEvents = reputationEvents.length

  if (totalEvents === 0) {
    return {
      sampleSize: 0,
      metrics: {
        completionPaidRate: 0,
        disputedRate: 0,
        repeatBookingRate: 0,
        avgPaidMinutes: 0,
        skillCoverage: 0
      }
    }
  }

  const completedPaid = reputationEvents.filter((event) => event.outcome === 'completed' && event.paidMinutes > 0 && event.disputed !== true).length
  const disputed = reputationEvents.filter((event) => event.disputed === true).length
  const repeatBookings = reputationEvents.filter((event) => event.repeatBooking === true).length
  const paidMinutes = reputationEvents.map((event) => Number(event.paidMinutes || 0))
  const avgPaidMinutes = paidMinutes.length > 0 ? Number((paidMinutes.reduce((sum, value) => sum + value, 0) / paidMinutes.length).toFixed(2)) : 0
  const expertiseSet = new Set()

  for (const event of reputationEvents) {
    for (const skill of safeArray(event.expertise)) {
      expertiseSet.add(String(skill).toLowerCase())
    }
  }

  return {
    sampleSize: totalEvents,
    metrics: {
      completionPaidRate: Number((completedPaid / totalEvents).toFixed(4)),
      disputedRate: Number((disputed / totalEvents).toFixed(4)),
      repeatBookingRate: Number((repeatBookings / totalEvents).toFixed(4)),
      avgPaidMinutes,
      skillCoverage: expertiseSet.size
    }
  }
}

function scoreDiscoveryCandidate(profile, filters = {}, { includeBreakdown = false } = {}) {
  const skills = safeArray(profile.expertise).map((skill) => String(skill).toLowerCase())
  const targetSkill = String(filters.domain || '').trim().toLowerCase()
  const skillMatch = targetSkill && skills.includes(targetSkill) ? 1 : 0

  const budget = Number(filters.maxBudget || 0)
  const budgetScore = budget > 0 && profile.hourlyRate ? (profile.hourlyRate <= budget ? 1 : 0) : 0.5

  const timezone = String(filters.timezone || '').toLowerCase()
  const timezoneScore = timezone && String(profile.timezone || '').toLowerCase() === timezone ? 1 : 0.5

  const language = String(filters.language || '').toLowerCase()
  const languageScore = language && safeArray(profile.languages).map((item) => String(item).toLowerCase()).includes(language) ? 1 : 0.5

  const chainPreference = String(filters.chainPreference || '').trim()
  const chainScore = chainPreference && Number(profile.chainPreference) === Number(chainPreference) ? 1 : 0.5

  const reputation = buildReputationSummary(profile.wallet)
  const completionRate = reputation.events > 0 ? reputation.completed / reputation.events : 0.5

  const outcomeHistoryBoost = targetSkill ? rankingModel.expertiseScores[targetSkill] || 0.5 : 0.5
  const weightedComponents = {
    skillMatch: skillMatch * rankingModel.weights.skillMatch,
    budgetScore: budgetScore * rankingModel.weights.budgetScore,
    timezoneScore: timezoneScore * rankingModel.weights.timezoneScore,
    languageScore: languageScore * rankingModel.weights.languageScore,
    chainScore: chainScore * rankingModel.weights.chainScore,
    completionRate: completionRate * rankingModel.weights.completionRate,
    outcomeHistoryBoost: outcomeHistoryBoost * rankingModel.weights.outcomeHistoryBoost
  }
  const weighted = Object.values(weightedComponents).reduce((sum, value) => sum + value, 0)
  const totalScore = Number((weighted * 100).toFixed(2))

  if (!includeBreakdown) {
    return totalScore
  }

  const breakdown = {
    skillMatch: Number((weightedComponents.skillMatch * 100).toFixed(2)),
    budgetFit: Number((weightedComponents.budgetScore * 100).toFixed(2)),
    timezoneFit: Number((weightedComponents.timezoneScore * 100).toFixed(2)),
    languageFit: Number((weightedComponents.languageScore * 100).toFixed(2)),
    chainFit: Number((weightedComponents.chainScore * 100).toFixed(2)),
    completionHistory: Number((weightedComponents.completionRate * 100).toFixed(2)),
    outcomeHistoryBoost: Number((weightedComponents.outcomeHistoryBoost * 100).toFixed(2))
  }

  const explanation = []
  if (targetSkill && skillMatch > 0) explanation.push('direct skill match')
  if (budget > 0 && budgetScore === 1) explanation.push('within requested budget')
  if (timezone && timezoneScore === 1) explanation.push('timezone aligned')
  if (language && languageScore === 1) explanation.push('language aligned')
  if (chainPreference && chainScore === 1) explanation.push('chain preference aligned')
  if (reputation.events > 0) explanation.push('has prior outcomes history')
  if (explanation.length === 0) explanation.push('baseline compatibility profile')

  return {
    totalScore,
    breakdown,
    explanation,
    modelVersion: rankingModel.version
  }
}

function buildConversationAssist(thread) {
  const messages = safeArray(thread?.messages)
  const text = messages.map((item) => item.text).join(' ').toLowerCase()

  const goals = []
  if (text.includes('deadline') || text.includes('deliver')) goals.push('align delivery timeline')
  if (text.includes('budget') || text.includes('rate') || text.includes('cost')) goals.push('confirm budget and pricing model')
  if (text.includes('scope') || text.includes('requirements')) goals.push('lock scope and success criteria')
  if (text.includes('risk') || text.includes('security')) goals.push('address risks and security concerns')
  if (!goals.length) goals.push('define session objective and concrete next step')

  const lastThree = messages.slice(-3).map((item) => item.text).join(' ')

  return {
    goals,
    suggestedQuestions: [
      'What is the single highest-priority outcome for this session?',
      'Which constraints can block delivery in the next 7 days?',
      'What evidence confirms this engagement is successful?'
    ],
    summary: lastThree || 'No conversation messages yet.'
  }
}

function scorePaymentRisk({ senderWallet, recipientWallet, amount, duration, chainId }) {
  const numericAmount = Number(amount)
  const numericDuration = Number(duration)
  const senderStreams = Array.from(paymentStreams.values()).filter((stream) => stream.senderWallet === senderWallet.toLowerCase())
  const medianAmount = median(senderStreams.map((stream) => Number(stream.amount)))
  const recentWindow = nowSeconds() - 3600
  const recentCount = senderStreams.filter((stream) => Number(stream.start_time) >= recentWindow).length

  const flags = []
  let riskScore = 0

  if (medianAmount > 0 && numericAmount > medianAmount * 3) {
    flags.push('amount_spike')
    riskScore += 35
  }

  if (recentCount >= 5) {
    flags.push('high_velocity')
    riskScore += 30
  }

  if (numericDuration < 300) {
    flags.push('short_duration')
    riskScore += 20
  }

  if (!chainRegistry.get(String(chainId))?.enabled) {
    flags.push('unsupported_chain')
    riskScore += 40
  }

  if (senderWallet.toLowerCase() === recipientWallet.toLowerCase()) {
    flags.push('self_payment')
    riskScore += 60
  }

  return {
    riskScore: Math.min(100, riskScore),
    severity: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
    flags,
    reasons: flags.length
      ? flags.map((flag) => ({
        code: flag,
        message: flag === 'amount_spike'
          ? 'Payment amount is significantly above recent median'
          : flag === 'high_velocity'
            ? 'High payment initiation velocity detected'
            : flag === 'short_duration'
              ? 'Very short stream duration may indicate misuse'
              : flag === 'unsupported_chain'
                ? 'Requested chain is not enabled for settlement'
                : 'Sender and recipient are the same wallet'
      }))
      : [{ code: 'normal_pattern', message: 'No abnormal payment risk pattern detected' }],
    recommendedAction: riskScore >= 70 ? 'block_and_manual_review' : riskScore >= 40 ? 'allow_with_confirmation' : 'allow'
  }
}

function getOrCreateUser(wallet) {
  const walletAddress = wallet.toLowerCase()
  const existing = profiles.get(walletAddress)?.user || null

  if (existing) {
    return existing
  }

  const user = {
    id: walletAddress,
    wallet_address: walletAddress,
    wallet_type: 'injected',
    ens_name: null,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  profiles.set(walletAddress, { user, profile: null })
  markStateDirty()
  return user
}

function calculateProfileCompleteness(profile) {
  const fields = ['name', 'bio', 'hourlyRate', 'expertise']
  const filled = fields.filter((field) => profile[field] != null && profile[field] !== '').length
  return Math.round((filled / fields.length) * 100)
}

function calculateStreamedAmount(stream) {
  const currentTime = nowSeconds()

  if (currentTime <= stream.start_time) {
    return 0
  }

  if (currentTime >= stream.stop_time) {
    return stream.amount
  }

  const progress = (currentTime - stream.start_time) / (stream.stop_time - stream.start_time)
  return Number((stream.amount * progress).toFixed(8))
}

function assertStreamAccess(stream, walletAddress, action = 'access') {
  const normalizedWallet = walletAddress.toLowerCase()

  if (stream.senderWallet !== normalizedWallet && stream.recipientWallet !== normalizedWallet) {
    throw new AuthorizationError(`Cannot ${action} this stream`)
  }
}

function assertStreamRecipient(stream, walletAddress, action = 'withdraw from') {
  if (stream.recipientWallet !== walletAddress.toLowerCase()) {
    throw new AuthorizationError(`Only the stream recipient can ${action} this stream`)
  }
}

try {
  validateConfig()
} catch (error) {
  logger.error('Configuration validation failed', error)
  throw error
}

app.use(helmet())
app.use(cors(config.cors))
app.use(express.json({ limit: config.server.requestBodyLimit }))
app.use(express.urlencoded({ extended: true, limit: config.server.requestBodyLimit }))
app.use(requestLogger)
app.use((req, res, next) => {
  const startedAt = Date.now()

  res.on('finish', () => {
    requestMetrics.total += 1
    if (res.statusCode >= 500) {
      requestMetrics.errors += 1
    }

    const latency = Date.now() - startedAt
    requestMetrics.latencies.push(latency)
    if (requestMetrics.latencies.length > 1000) {
      requestMetrics.latencies.shift()
    }
  })

  next()
})
app.set('trust proxy', config.server.trustProxy ? 1 : false)

function authenticateToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1]

  if (!token) {
    return next(new AuthenticationError('No token provided'))
  }

  try {
    req.user = verifyToken(token)
    req.userId = req.user.userId
    req.walletAddress = req.user.walletAddress
    req.scopes = safeArray(req.user.scopes)
    next()
  } catch (error) {
    next(new AuthenticationError(error.message))
  }
}

function authenticatePublicApi(req, res, next) {
  if (!config.publicApi.key) {
    return next(new AppError('Public API is not configured', 503))
  }

  const key = req.headers['x-api-key']
  if (!key || key !== config.publicApi.key) {
    return next(new AuthenticationError('Invalid API key'))
  }

  return next()
}

app.get('/health', (req, res) => {
  const reliability = computeReliabilityMetrics()
  const p95Latency = percentile(requestMetrics.latencies, 95)

  res.json({
    status: 'healthy',
    service: 'paytray-backend',
    version: '0.1.0',
    environment: config.env,
    timestamp: new Date().toISOString(),
    checks: {
      database: getDatabaseStatus(),
      livekit: config.livekit.apiKey ? 'configured' : 'missing',
      paymentsReliability: reliability.reliabilityPct,
      p95LatencyMs: p95Latency
    }
  })
})

app.get('/api/health', (req, res) => {
  const reliability = computeReliabilityMetrics()

  res.json({
    status: 'healthy',
    service: 'paytray-backend',
    version: '0.1.0',
    environment: config.env,
    timestamp: nowIso(),
    metrics: {
      reliability
    }
  })
})

function getReadinessReport() {
  return buildReadinessReport({
    env: config.env,
    databaseStatus: getDatabaseStatus(),
    protocol: config.payments.protocol,
    protocolContractAddress: config.payments.protocolContractAddress,
    enabledTokenCount: paymentTokenRegistry.list({ enabledOnly: true }).length
  })
}

app.get('/readyz', (req, res) => {
  const report = getReadinessReport()
  res.status(report.ready ? 200 : 503).json({
    service: 'paytray-backend',
    timestamp: nowIso(),
    ...report
  })
})

app.get('/api/health/readiness', (req, res) => {
  const report = getReadinessReport()
  res.status(report.ready ? 200 : 503).json({
    success: report.ready,
    ...report
  })
})

app.get('/api/v2/collaboration/health', (req, res) => {
  const report = buildCollaborationHealth({
    env: config.env,
    databaseStatus: getDatabaseStatus(),
    livekitStatus: config.livekit.apiKey ? 'ready' : 'not_configured',
    sessionAuthStatus: config.jwt.secret ? 'ready' : 'unconfigured',
    paymentRpcStatus: config.payments.rpcUrl ? 'ready' : 'not_configured',
    verifierStatus: 'not_configured',
    indexerStatus: 'not_configured'
  })
  res.status(report.collaborationAvailable ? 200 : 503).json({ success: report.collaborationAvailable, health: report })
})

app.post('/api/auth/challenge', (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.body.wallet)
    const limitKey = `auth:challenge:${wallet}:${getClientIP(req)}`
    checkRateLimit(limitKey, config.rateLimit.tokenGenLimit, config.rateLimit.windowMs)

    const challenge = createAuthChallenge(wallet)
    requestMetrics.auth.challengesIssued += 1

    res.json({
      success: true,
      challenge: {
        id: challenge.id,
        wallet: challenge.wallet,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        message: challenge.message
      }
    })
  } catch (error) {
    if (error instanceof RateLimitError) {
      requestMetrics.auth.challengeRateLimited += 1
    }

    next(error)
  }
})

app.post('/api/auth/login', (req, res, next) => {
  try {
    const { wallet, signature, challengeId, message, scopes: requestedScopes } = req.body
    const validated = validate(
      {
        wallet: schemas.wallet.address,
        signature: schemas.wallet.signature
      },
      { wallet, signature }
    )

    const loginLimitKey = `auth:login:${validated.wallet}:${getClientIP(req)}`
    checkRateLimit(loginLimitKey, config.auth.loginAttemptLimit, config.rateLimit.windowMs)

    if (typeof challengeId !== 'string' || !challengeId.trim()) {
      throw new AuthenticationError('Auth challenge is required')
    }

    if (typeof message !== 'string' || !message.trim()) {
      throw new AuthenticationError('Auth challenge message is required')
    }

    consumeAuthChallenge(challengeId, validated.wallet, message)
    const verification = verifyWalletSignature(message, validated.signature, validated.wallet)

    if (!verification.verified) {
      throw new AuthenticationError('Invalid signature')
    }

    const user = getOrCreateUser(validated.wallet)
  const defaultScopes = getDefaultScopes(user.wallet_address)
  const scopes = resolveLoginScopes(defaultScopes, requestedScopes)
    const tokens = generateTokenPair(user.id, user.wallet_address, scopes)
    requestMetrics.auth.loginSuccess += 1

    res.json({
      success: true,
      user: {
        id: user.id,
        wallet: user.wallet_address,
        ensName: user.ens_name,
        scopes
      },
      tokens
    })
  } catch (error) {
    if (error instanceof RateLimitError) {
      requestMetrics.auth.loginRateLimited += 1
    }

    requestMetrics.auth.loginFailed += 1
    next(error)
  }
})

app.get('/api/users/me', authenticateToken, (req, res, next) => {
  try {
    const user = profiles.get(req.walletAddress)?.user

    if (!user) {
      throw new NotFoundError('User')
    }

    res.json({ user, profile: profiles.get(req.walletAddress)?.profile || null })
  } catch (error) {
    next(error)
  }
})

app.post('/api/profiles', authenticateToken, (req, res, next) => {
  try {
    const validated = validate(
      {
        name: schemas.user.name,
        bio: schemas.user.bio,
        hourlyRate: schemas.user.hourlyRate,
        expertise: schemas.user.expertise
      },
      req.body
    )

    const profile = {
      wallet: req.walletAddress,
      ...validated,
      socialLinks: req.body.socialLinks || null,
      availability: req.body.availability || null,
      timezone: req.body.timezone || null,
      languages: safeArray(req.body.languages),
      chainPreference: req.body.chainPreference ? Number(req.body.chainPreference) : config.payments.settlementChainId,
      isExpert: true,
      updatedAt: new Date().toISOString(),
      completeness: calculateProfileCompleteness(validated)
    }

    const userRecord = getOrCreateUser(req.walletAddress)
    profiles.set(req.walletAddress, { user: userRecord, profile })
    markStateDirty()

    res.json({ success: true, profile, exists: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/profiles/search', (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim().toLowerCase()

    if (!query) {
      throw new ValidationError('Search query is required')
    }

    const results = []

    for (const [wallet, record] of profiles.entries()) {
      if (!record.profile) continue
      const matchesName = record.profile.name?.toLowerCase().includes(query)
      const matchesExpertise = Array.isArray(record.profile.expertise) && record.profile.expertise.some((item) => item.toLowerCase().includes(query))

      if (matchesName || matchesExpertise || wallet.includes(query)) {
        results.push(record.profile)
      }
    }

    res.json({ success: true, query, count: results.length, results })
  } catch (error) {
    next(error)
  }
})

app.get('/api/profiles/experts/:expertise', (req, res) => {
  const expertise = req.params.expertise.toLowerCase()
  const experts = []

  for (const record of profiles.values()) {
    if (!record.profile?.isExpert) continue
    if (record.profile.expertise?.some((item) => item.toLowerCase() === expertise)) {
      experts.push(record.profile)
    }
  }

  res.json({ success: true, expertise, count: experts.length, experts })
})

app.get('/api/profiles/trending', (req, res, next) => {
  try {
    const limit = Number.parseInt(req.query.limit || '10', 10)

    if (!Number.isFinite(limit) || limit <= 0) {
      throw new ValidationError('Limit must be a positive integer')
    }

    const trending = Array.from(profiles.values())
      .filter((record) => Boolean(record.profile))
      .map((record) => record.profile)
      .sort((a, b) => (b.completeness || 0) - (a.completeness || 0))
      .slice(0, limit)

    res.json({ success: true, count: trending.length, profiles: trending })
  } catch (error) {
    next(error)
  }
})

app.get('/api/profiles/:wallet', (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)
    const record = profiles.get(wallet)

    res.json({
      success: true,
      wallet,
      profile: record?.profile || null,
      exists: Boolean(record?.profile)
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/profiles/:wallet', authenticateToken, (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)

    if (wallet !== req.walletAddress.toLowerCase()) {
      throw new AuthorizationError('Can only update your own profile')
    }

    const validated = validate(
      {
        name: schemas.user.name,
        bio: schemas.user.bio,
        hourlyRate: schemas.user.hourlyRate,
        expertise: schemas.user.expertise
      },
      req.body
    )

    const profile = {
      wallet,
      ...validated,
      socialLinks: req.body.socialLinks || null,
      availability: req.body.availability || null,
      timezone: req.body.timezone || null,
      languages: safeArray(req.body.languages),
      chainPreference: req.body.chainPreference ? Number(req.body.chainPreference) : config.payments.settlementChainId,
      isExpert: true,
      updatedAt: new Date().toISOString(),
      completeness: calculateProfileCompleteness(validated)
    }

    profiles.set(wallet, { user: getOrCreateUser(wallet), profile })
    markStateDirty()
    res.json({ success: true, profile, exists: true })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/profiles/:wallet', authenticateToken, (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)

    if (wallet !== req.walletAddress.toLowerCase()) {
      throw new AuthorizationError('Can only delete your own profile')
    }

    const record = profiles.get(wallet) || { user: getOrCreateUser(wallet), profile: null }
    profiles.set(wallet, { ...record, profile: null })
    markStateDirty()
    res.json({ success: true, wallet, exists: false })
  } catch (error) {
    next(error)
  }
})

app.post('/api/discovery/search', authenticateToken, (req, res, next) => {
  try {
    const filters = {
      domain: req.body.domain || null,
      maxBudget: req.body.maxBudget || null,
      timezone: req.body.timezone || null,
      language: req.body.language || null,
      chainPreference: req.body.chainPreference || config.payments.settlementChainId,
      availableDay: req.body.availableDay ? String(req.body.availableDay).toLowerCase() : null
    }

    const candidates = Array.from(profiles.values())
      .map((record) => record.profile)
      .filter((profile) => Boolean(profile) && profile.wallet !== req.walletAddress)
      .filter((profile) => {
        if (!filters.availableDay) return true
        if (!profile.availability?.days?.length) return true
        return profile.availability.days.includes(filters.availableDay)
      })
      .map((profile) => {
        const ranked = scoreDiscoveryCandidate(profile, filters, { includeBreakdown: true })
        return {
          profile,
          score: ranked.totalScore,
          scoreBreakdown: ranked.breakdown,
          scoreExplanation: ranked.explanation,
          modelVersion: ranked.modelVersion
        }
      })
      .sort((a, b) => b.score - a.score)

    const sessionId = String(matchSessions.size + 1)
    const session = {
      id: sessionId,
      requesterWallet: req.walletAddress,
      filters,
      candidateWallets: candidates.map((item) => item.profile.wallet),
      createdAt: nowIso(),
      selectedWallet: null
    }

    matchSessions.set(sessionId, session)
    markStateDirty()

    res.json({
      success: true,
      matchSession: session,
      count: candidates.length,
      candidates,
      rankingModel: {
        version: rankingModel.version,
        trainedAt: rankingModel.trainedAt,
        weights: rankingModel.weights
      }
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/matches/:sessionId/select', authenticateToken, (req, res, next) => {
  try {
    const session = matchSessions.get(req.params.sessionId)
    if (!session) {
      throw new NotFoundError('Match session')
    }

    if (session.requesterWallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot modify this match session')
    }

    const expertWallet = schemas.wallet.address(req.body.expertWallet)
    if (!session.candidateWallets.includes(expertWallet)) {
      throw new ValidationError('Selected expert was not in candidate set')
    }

    session.selectedWallet = expertWallet
    session.selectedAt = nowIso()
    matchSessions.set(session.id, session)

    const contractId = String(engagementContracts.size + 1)
    const engagementContract = {
      id: contractId,
      sessionId: session.id,
      requesterWallet: req.walletAddress,
      expertWallet,
      pricingMode: req.body.pricingMode || 'hourly',
      expectedDurationMinutes: Number(req.body.expectedDurationMinutes || 60),
      cancellationPolicy: req.body.cancellationPolicy || '24h',
      status: 'draft',
      createdAt: nowIso()
    }

    engagementContracts.set(contractId, engagementContract)
    markStateDirty()

    res.json({ success: true, matchSession: session, engagementContract })
  } catch (error) {
    next(error)
  }
})

app.post('/api/matches/:sessionId/handoff', authenticateToken, async (req, res, next) => {
  try {
    const session = matchSessions.get(req.params.sessionId)

    if (!session) {
      throw new NotFoundError('Match session')
    }

    if (session.requesterWallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot handoff this match session')
    }

    if (!session.selectedWallet) {
      throw new ValidationError('Select an expert before handoff')
    }

    const threadId = String(conversationThreads.size + 1)
    const context = {
      objective: req.body.objective || 'intro consultation',
      budget: Number(req.body.budget || 0),
      suggestedAgenda: safeArray(req.body.suggestedAgenda),
      chainPreference: Number(req.body.chainPreference || session.filters.chainPreference || config.payments.settlementChainId)
    }

    const thread = {
      id: threadId,
      sessionId: session.id,
      participants: [session.requesterWallet, session.selectedWallet],
      context,
      messages: [],
      status: 'active',
      createdAt: nowIso()
    }

    conversationThreads.set(threadId, thread)
    markStateDirty()

    await enqueueWebhookDeliveries('match.handoff.created', {
      threadId: thread.id,
      sessionId: session.id,
      participants: thread.participants,
      context: thread.context,
      createdAt: thread.createdAt
    })

    res.json({ success: true, thread, handoff: { context, sessionId: session.id } })
  } catch (error) {
    next(error)
  }
})

app.post('/api/threads/:threadId/messages', authenticateToken, (req, res, next) => {
  try {
    const thread = conversationThreads.get(req.params.threadId)

    if (!thread) {
      throw new NotFoundError('Conversation thread')
    }

    if (!thread.participants.includes(req.walletAddress)) {
      throw new AuthorizationError('Cannot post to this thread')
    }

    const text = String(req.body.text || '').trim()
    if (!text) {
      throw new ValidationError('Message text is required')
    }

    const message = {
      id: String(thread.messages.length + 1),
      authorWallet: req.walletAddress,
      text,
      createdAt: nowIso()
    }

    thread.messages.push(message)
    conversationThreads.set(thread.id, thread)
    markStateDirty()

    res.json({ success: true, threadId: thread.id, message })
  } catch (error) {
    next(error)
  }
})

app.get('/api/threads/:threadId', authenticateToken, (req, res, next) => {
  try {
    const thread = conversationThreads.get(req.params.threadId)

    if (!thread) {
      throw new NotFoundError('Conversation thread')
    }

    if (!thread.participants.includes(req.walletAddress)) {
      throw new AuthorizationError('Cannot view this thread')
    }

    res.json({ success: true, thread })
  } catch (error) {
    next(error)
  }
})

app.post('/api/reputation/events', authenticateToken, async (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.body.wallet || req.walletAddress)
    const outcome = String(req.body.outcome || '').toLowerCase()

    if (!['completed', 'cancelled', 'no_show'].includes(outcome)) {
      throw new ValidationError('Outcome must be completed, cancelled, or no_show')
    }

    const event = {
      id: String(reputationEvents.length + 1),
      wallet,
      sessionId: req.body.sessionId ? String(req.body.sessionId) : null,
      streamId: req.body.streamId ? String(req.body.streamId) : null,
      outcome,
      paidMinutes: Number(req.body.paidMinutes || 0),
      repeatBooking: Boolean(req.body.repeatBooking),
      disputed: Boolean(req.body.disputed),
      expertise: safeArray(req.body.expertise).map((item) => String(item).toLowerCase()),
      createdAt: nowIso()
    }

    reputationEvents.push(event)
    recomputeRankingEvaluation()
    markStateDirty()

    await enqueueWebhookDeliveries('reputation.event.created', {
      eventId: event.id,
      wallet: event.wallet,
      outcome: event.outcome,
      paidMinutes: event.paidMinutes,
      disputed: event.disputed,
      createdAt: event.createdAt
    })

    res.json({ success: true, event, summary: buildReputationSummary(wallet) })
  } catch (error) {
    next(error)
  }
})

app.get('/api/reputation/:wallet', (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)
    res.json({ success: true, summary: buildReputationSummary(wallet) })
  } catch (error) {
    next(error)
  }
})

app.post('/api/livekit/token', authenticateToken, (req, res, next) => {
  try {
    if (!config.livekit.apiKey || !config.livekit.apiSecret) {
      throw new AppError('LiveKit token service is not configured', 503)
    }

    const validated = validate(
      {
        roomName: schemas.livekit.roomName,
        username: schemas.livekit.username
      },
      req.body
    )

    checkRateLimit(req.walletAddress || getClientIP(req), config.rateLimit.tokenGenLimit)

    const token = generateServiceToken(
      {
        type: 'livekit_session',
        userId: req.userId,
        walletAddress: req.walletAddress,
        roomName: validated.roomName,
        username: validated.username,
        scopes: req.scopes
      },
      config.livekit.apiSecret,
      `${config.livekit.tokenTTL}s`,
      'paytray-livekit'
    )

    res.json({
      token,
      url: config.livekit.url,
      room: validated.roomName,
      identity: req.walletAddress,
      expiresIn: config.livekit.tokenTTL
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/wallet/verify', (req, res, next) => {
  try {
    const validated = validate(
      {
        wallet: schemas.wallet.address,
        signature: schemas.wallet.signature
      },
      {
        wallet: req.body.wallet,
        signature: req.body.signature
      }
    )

    const chainId = Number.parseInt(req.body.chainId || '1', 10)
    const message = String(req.body.message || '').trim()
    const challengeId = String(req.body.challengeId || '').trim()

    if (!message) {
      throw new ValidationError('Message is required')
    }

    if (message.length > 2000) {
      throw new ValidationError('Message must be 2000 characters or fewer')
    }

    if (!Number.isFinite(chainId)) {
      throw new ValidationError('Chain id must be an integer')
    }

    const supportedChainIds = getSupportedVerificationChainIds()
    if (!supportedChainIds.has(chainId)) {
      throw new ValidationError('Chain not supported')
    }

    if (!challengeId) {
      throw new AuthenticationError('Wallet verification challenge is required')
    }

    checkRateLimit(`wallet:verify:${validated.wallet}:${getClientIP(req)}`, config.auth.walletVerifyAttemptLimit, config.rateLimit.windowMs)
    consumeWalletVerifyChallenge(challengeId, validated.wallet, message, chainId)

    const verification = verifyWalletSignature(message, validated.signature, validated.wallet)
    if (!verification.verified) {
      throw new AuthenticationError('Invalid signature')
    }

    requestMetrics.walletVerification.verifySuccess += 1

    res.json({
      valid: true,
      wallet: validated.wallet,
      chainId,
      verified: true,
      signer: verification.address,
      message: verification.message
    })
  } catch (error) {
    if (error instanceof RateLimitError) {
      requestMetrics.walletVerification.verifyRateLimited += 1
    }

    requestMetrics.walletVerification.verifyFailed += 1
    next(error)
  }
})

app.post('/api/wallet/verify/challenge', (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.body.wallet)
    const chainId = Number.parseInt(req.body.chainId || String(config.payments.settlementChainId), 10)

    if (!Number.isFinite(chainId)) {
      throw new ValidationError('Chain id must be an integer')
    }

    const supportedChainIds = getSupportedVerificationChainIds()
    if (!supportedChainIds.has(chainId)) {
      throw new ValidationError('Chain not supported')
    }

    checkRateLimit(`wallet:verify:challenge:${wallet}:${getClientIP(req)}`, config.rateLimit.tokenGenLimit, config.rateLimit.windowMs)
    const challenge = createWalletVerifyChallenge(wallet, chainId)
    requestMetrics.walletVerification.challengesIssued += 1

    res.json({
      success: true,
      challenge: {
        id: challenge.id,
        wallet: challenge.wallet,
        chainId: challenge.chainId,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        expiresAt: challenge.expiresAt,
        message: challenge.message
      }
    })
  } catch (error) {
    if (error instanceof RateLimitError) {
      requestMetrics.walletVerification.challengeRateLimited += 1
    }

    next(error)
  }
})

app.post('/api/v2/verifier/poll', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'verifier polling requires a ready PostgreSQL database')
    }
    if (!config.payments.rpcUrl) {
      throw new ExternalServiceError('Base Sepolia RPC', 'PAYMENT_RPC_URL is required before verifier polling can run')
    }
    const result = await transaction(async (client) => {
      const worker = createConfiguredBaseSepoliaVerifierWorker({
        client,
        rpcUrl: config.payments.rpcUrl,
        tokenRegistry: paymentTokenRegistry,
        contractAddress: config.payments.protocolContractAddress,
        finalityConfirmations: config.payments.finalityConfirmations,
        verifierId: req.walletAddress
      })
      return worker.pollOnce({
        fromBlock: req.body?.fromBlock == null ? null : Number(req.body.fromBlock),
        toBlock: req.body?.toBlock == null ? null : Number(req.body.toBlock)
      })
    })
    res.json({ success: true, result, authority: 'verifier_worker', promotionStatus: 'shadow_only' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/verifier/chain-events', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'verified chain-event ingestion requires a ready PostgreSQL database')
    }
    const result = await transaction((client) => processVerifiedChainEvent({
      client,
      config,
      tokenRegistry: paymentTokenRegistry,
      streamId: req.body.streamId,
      intentId: req.body.intentId || null,
      event: req.body.event,
      verifierId: req.walletAddress
    }))
    res.status(200).json({
      success: true,
      ...result,
      authority: 'verifier_owned_chain_evidence'
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/telemetry/events', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'telemetry ingestion requires a ready PostgreSQL database')
    }
    const result = await transaction((client) => ingestTelemetryEvent({
      client,
      event: req.body,
      receivedAt: new Date()
    }))
    res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      event: result.event,
      idempotentReplay: result.idempotentReplay,
      ingestionLagMs: result.ingestionLagMs,
      authority: 'observability_only'
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/reconciliation/durable', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable reconciliation requires a ready PostgreSQL database')
    }
    const report = await transaction((client) => buildDurableReconciliationReport({ client, maxProjectionLagMs: config.payments.reconciliationLagThresholdMs }))
    res.status(report.status === 'ok' ? 200 : 503).json({ success: report.status === 'ok', report })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/shadow-runs/:runId', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'shadow-run details require a ready PostgreSQL database')
    }
    const details = await transaction((client) => getShadowRunDetails({ client, runId: req.params.runId }))
    res.json({ success: true, ...details })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/shadow-runs', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'shadow-run queue requires a ready PostgreSQL database')
    }
    const queue = await transaction((client) => listShadowRuns({
      client,
      reviewerDecision: req.query.status || 'pending',
      limit: req.query.limit
    }))
    res.json({ success: true, ...queue, authority: 'human_review_required', promotionStatus: 'shadow_only' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/ops/shadow-runs/:runId/review', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'shadow-run review requires a ready PostgreSQL database')
    }
    const result = await transaction((client) => reviewShadowRun({
      client,
      runId: req.params.runId,
      reviewerId: req.walletAddress,
      decision: req.body.decision,
      notes: req.body.notes || null
    }))
    res.json({ success: true, ...result, applied: false, authority: 'human_review_required' })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/financial/summary', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'financial summary requires a ready PostgreSQL database')
    }
    const summary = await transaction((client) => getFinancialSummary({ client, config }))
    res.json({ success: true, summary })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/discovery/lineage', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'discovery lineage requires a ready PostgreSQL database')
    }
    const lineage = await transaction((client) => listDiscoveryOutcomeLineage({ client, ...req.query }))
    res.json({ success: true, lineage })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/audit/events', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'financial audit events require a ready PostgreSQL database')
    }
    const audit = await transaction((client) => listFinancialAuditEvents({ client, ...req.query }))
    res.json({ success: true, audit })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/verifier/status', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'verifier status requires a ready PostgreSQL database')
    }
    const status = await transaction((client) => getVerifierObservability({ client, config }))
    res.json({ success: true, status })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/intelligence/advisory/capabilities', authenticateToken, requireScopes('intelligence:*'), (req, res) => {
  res.json({ success: true, capabilities: getAdvisoryAiCapabilities({ config }) })
})

app.post('/api/v2/intelligence/advisory', authenticateToken, requireScopes('intelligence:*'), async (req, res, next) => {
  try {
    const request = createAdvisoryAiRequest({
      taskType: req.body.taskType,
      subject: req.body.subject,
      retrievalItems: req.body.retrievalItems,
      provenance: req.body.provenance,
      config
    })
    const result = await runBoundedAdvisory({ provider: app.locals.advisoryAiProvider, request, config })
    res.status(result.status === 'advisory' ? 200 : 503).json({ success: result.status === 'advisory', result })
  } catch (error) {
    if (error?.name === 'AdvisoryAiBoundaryError') return next(new ValidationError(error.message))
    next(error)
  }
})

app.get('/api/v2/ops/outbox/health', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'outbox health requires a ready PostgreSQL database')
    }
    const health = await transaction((client) => getOutboxHealth({ client, maxAttempts: config.webhooks.maxAttempts }))
    res.status(health.status === 'ok' ? 200 : 503).json({ success: health.status === 'ok', health })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/webhook-inbox/health', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'webhook inbox health requires a ready PostgreSQL database')
    }
    const health = await transaction((client) => getWebhookInboxHealth({ client }))
    res.status(health.status === 'ok' ? 200 : 503).json({ success: health.status === 'ok', health })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/outbox/events', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'outbox event inspection requires a ready PostgreSQL database')
    }
    const events = await transaction((client) => listOutboxEvents({
      client,
      limit: req.query.limit,
      offset: req.query.offset,
      status: req.query.status || null,
      maxAttempts: config.webhooks.maxAttempts
    }))
    res.json({ success: true, authority: 'durable_outbox_delivery_health', mutation: 'read_only', events })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/ops/outbox/process', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'outbox processing requires a ready PostgreSQL database')
    }
    const dryRun = req.body.dryRun !== false
    const result = await transaction(async (client) => processDurableOutbox({
      client,
      hooks: await listExtensionHooks({ client }),
      dryRun,
      limit: req.body.limit,
      leaseMs: req.body.leaseMs,
      maxAttempts: config.webhooks.maxAttempts,
      retryBaseDelayMs: config.webhooks.retryBaseDelayMs,
      timeoutMs: config.webhooks.timeoutMs,
      signingSecret: config.webhooks.signingSecret,
      signatureToleranceMs: config.webhooks.signatureToleranceMs
    }))
    res.status(result.status === 'ok' ? 200 : 503).json({ success: result.status === 'ok', ...result })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/verifier/operations', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'verifier operations evidence requires a ready PostgreSQL database')
    }
    const evidence = await transaction((client) => buildVerifierOperationsEvidence({ client, config }))
    res.status(evidence.status === 'ready' ? 200 : 503).json({ success: evidence.status === 'ready', evidence })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/verifier-observability', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'verifier observability requires a ready PostgreSQL database')
    }
    const report = await transaction((client) => getVerifierObservability({ client, config }))
    res.json({ success: true, report })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/evidence', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'unified operator evidence requires a ready PostgreSQL database')
    }
    const evidence = await transaction(async (client) => {
      const releaseEvidence = await collectReleaseEvidence({ client, config })
      const reconciliationEvidence = await collectReconciliationEvidence({ client, config })
      return buildUnifiedOperatorEvidence({ releaseEvidence, reconciliationEvidence })
    })
    res.status(evidence.evidenceComplete ? 200 : 503).json({ success: evidence.evidenceComplete, evidence })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/release-evidence', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'release evidence requires a ready PostgreSQL database')
    }
    const bundle = await transaction((client) => collectReleaseEvidence({ client, config }))
    res.status(bundle.evidenceComplete ? 200 : 503).json({ success: bundle.evidenceComplete, bundle })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/reconciliation/evidence', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'reconciliation evidence requires a ready PostgreSQL database')
    }
    const evidence = await transaction((client) => collectReconciliationEvidence({ client, config }))
    res.status(evidence.status === 'verified' ? 200 : 503).json({ success: evidence.status === 'verified', evidence })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/release-approval', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'release approval artifact requires a ready PostgreSQL database')
    }
    const artifact = await transaction(async (client) => {
      const readiness = await getReleaseReadiness({
        client,
        config,
        databaseStatus: getDatabaseStatus(),
        enabledTokenCount: paymentTokenRegistry.list({ enabledOnly: true }).length,
        verifierWorkerStatus: config.payments.rpcUrl ? 'configured' : 'not_configured'
      })
      const verifierStatus = await getVerifierObservability({ client, config })
      const reconciliation = await buildDurableReconciliationReport({ client, maxProjectionLagMs: config.payments.reconciliationLagThresholdMs })
      const shadowQueue = await listShadowRuns({ client, reviewerDecision: 'pending', limit: 100 })
      const rollbackResult = await client.query("SELECT COUNT(*)::int AS count FROM ai_evaluation_runs WHERE rollback_target IS NOT NULL")
      return buildReleaseApprovalArtifact({
        deploymentPreflight: buildDeploymentPreflight({ config, deploymentTarget: process.env.DEPLOYMENT_TARGET || 'unspecified' }),
        readiness,
        reconciliation,
        verifierStatus: verifierStatus.verifierStatus,
        pendingShadowReviews: shadowQueue.count,
        rollbackTargets: rollbackResult.rows[0]?.count || 0,
        humanApproval: null
      })
    })
    res.status(artifact.status === 'approved' ? 200 : 503).json({ success: artifact.status === 'approved', artifact })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/release-readiness', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'release readiness requires a ready PostgreSQL database')
    }
    const readiness = await transaction((client) => getReleaseReadiness({
      client,
      config,
      databaseStatus: getDatabaseStatus(),
      enabledTokenCount: paymentTokenRegistry.list({ enabledOnly: true }).length,
      verifierWorkerStatus: config.payments.rpcUrl ? 'configured' : 'not_configured'
    }))
    res.status(readiness.status === 'shadow_pilot_ready' ? 200 : 503).json({ success: readiness.status === 'shadow_pilot_ready', readiness })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/runtime/health', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'runtime health requires a ready PostgreSQL database')
    }
    const report = await transaction(async (client) => {
      const readiness = buildReadinessReport({
        env: config.env,
        databaseStatus: getDatabaseStatus(),
        protocol: config.payments.protocol,
        protocolContractAddress: config.payments.protocolContractAddress,
        enabledTokenCount: paymentTokenRegistry.list({ enabledOnly: true }).length,
        verifierWorkerStatus: config.verifierWorker.enabled ? 'configured' : 'not_configured'
      })
      const verifierOperations = await buildVerifierOperationsEvidence({ client, config })
      const outboxHealth = await getOutboxHealth({ client, maxAttempts: config.webhooks.maxAttempts })
      const webhookInboxHealth = await getWebhookInboxHealth({ client })
      const telemetryHealth = await getTelemetryHealth({ client })
      const collaboration = buildCollaborationHealth({
        env: config.env,
        databaseStatus: getDatabaseStatus(),
        livekitStatus: config.livekit.apiKey && config.livekit.apiSecret ? 'ready' : 'not_configured',
        sessionAuthStatus: config.jwt.secret ? 'ready' : 'error',
        paymentRpcStatus: config.payments.rpcUrl ? 'ready' : 'not_configured',
        verifierStatus: verifierOperations.verifier?.verifierStatus?.status || 'not_configured',
        indexerStatus: 'not_configured'
      })
      return buildRuntimeHealthReport({
        requestMetrics,
        readiness,
        collaboration,
        verifierOperations,
        outboxHealth,
        webhookInboxHealth,
        telemetryHealth,
        databaseStatus: getDatabaseStatus(),
        observability: config.observability
      })
    })
    res.status(report.status === 'ok' ? 200 : 503).json({ success: report.status === 'ok', report })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/health/dashboard', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'operator health dashboard requires a ready PostgreSQL database')
    }
    const dashboard = await transaction(async (client) => {
      const readiness = buildReadinessReport({
        env: config.env,
        databaseStatus: getDatabaseStatus(),
        protocol: config.payments.protocol,
        protocolContractAddress: config.payments.protocolContractAddress,
        enabledTokenCount: paymentTokenRegistry.list({ enabledOnly: true }).length,
        verifierWorkerStatus: config.verifierWorker.enabled ? 'configured' : 'not_configured'
      })
      const verifierOperations = await buildVerifierOperationsEvidence({ client, config })
      const outboxHealth = await getOutboxHealth({ client, maxAttempts: config.webhooks.maxAttempts })
      const webhookInboxHealth = await getWebhookInboxHealth({ client })
      const telemetryHealth = await getTelemetryHealth({ client })
      const collaboration = buildCollaborationHealth({
        env: config.env,
        databaseStatus: getDatabaseStatus(),
        livekitStatus: config.livekit.apiKey && config.livekit.apiSecret ? 'ready' : 'not_configured',
        sessionAuthStatus: config.jwt.secret ? 'ready' : 'error',
        paymentRpcStatus: config.payments.rpcUrl ? 'ready' : 'not_configured',
        verifierStatus: verifierOperations.verifier?.verifierStatus?.status || 'not_configured',
        indexerStatus: 'not_configured'
      })
      const runtimeHealth = buildRuntimeHealthReport({
        requestMetrics,
        readiness,
        collaboration,
        verifierOperations,
        outboxHealth,
        webhookInboxHealth,
        telemetryHealth,
        databaseStatus: getDatabaseStatus(),
        observability: config.observability
      })
      const releaseEvidence = await collectReleaseEvidence({ client, config })
      const reconciliationEvidence = await collectReconciliationEvidence({ client, config })
      const unifiedEvidence = buildUnifiedOperatorEvidence({ releaseEvidence, reconciliationEvidence })
      return buildOperatorHealthDashboard({
        runtimeHealth,
        outboxHealth,
        webhookInboxHealth,
        verifierOperations,
        unifiedEvidence
      })
    })
    res.status(dashboard.status === 'ok' ? 200 : 503).json({ success: dashboard.status === 'ok', dashboard })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/evidence/bundle', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'operator evidence bundle requires a ready PostgreSQL database')
    }
    const bundle = await transaction(async (client) => {
      const releaseEvidence = await collectReleaseEvidence({ client, config })
      const reconciliationEvidence = await collectReconciliationEvidence({ client, config })
      const operationsQualityRuns = await listOperationsQualityRuns({ client, limit: 20 })
      return buildOperatorEvidenceBundle({ releaseEvidence, reconciliationEvidence, operationsQualityRuns })
    })
    res.status(bundle.status === 'complete_pending_release_gate' ? 200 : 503).json({ success: bundle.status === 'complete_pending_release_gate', bundle })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/release-gates/latest', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'latest release-gates audit requires a ready PostgreSQL database')
    }
    const releaseGates = await transaction((client) => getLatestReleaseGatesRun({ client }))
    res.status(releaseGates.status === 'ok' ? 200 : 503).json({ success: releaseGates.status === 'ok', releaseGates })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/operations-quality/runs/:runId', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'operations-quality audit requires a ready PostgreSQL database')
    }
    const run = await transaction((client) => getOperationsQualityRun({ client, runId: req.params.runId }))
    if (!run) throw new NotFoundError('Operations-quality run')
    res.json({ success: true, run })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/ops/operations-quality/runs', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'operations-quality audit requires a ready PostgreSQL database')
    }
    const runs = await transaction((client) => listOperationsQualityRuns({
      client,
      limit: req.query.limit,
      status: req.query.status
    }))
    res.json({ success: true, runs })
  } catch (error) {
    next(error)
  }
})
app.get('/api/v2/telemetry/health', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'telemetry health requires a ready PostgreSQL database')
    }
    const health = await transaction((client) => getTelemetryHealth({ client }))
    res.json({ success: true, health, authority: 'observability_only' })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/discovery/experts', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable discovery requires a ready PostgreSQL database')
    }
    const queryId = req.get('x-query-id') || undefined
    const queryFeatures = {
      query: req.query.q || '',
      availability: req.query.availability || null,
      language: req.query.language || null,
      timezone: req.query.timezone || null,
      maxHourlyRate: req.query.maxHourlyRate || null
    }
    const experts = await transaction(async (client) => {
      const ranked = await searchExperts({
        client,
        query: queryFeatures.query,
        filters: {
          availability: queryFeatures.availability,
          language: queryFeatures.language,
          timezone: queryFeatures.timezone,
          maxHourlyRate: queryFeatures.maxHourlyRate
        },
        limit: req.query.limit
      })
      const impression = await recordDiscoveryImpressions({
        client,
        walletAddress: req.walletAddress,
        queryId,
        queryFeatures,
        experts: ranked
      })
      for (const expert of ranked) {
        await ingestTelemetryEvent({
          client,
          event: {
            eventId: `discovery-impression:${impression.queryId}:${expert.id}`,
            eventType: 'discovery_impression',
            occurredAt: new Date().toISOString(),
            actorScope: 'authenticated_client',
            entityType: 'expert_profile',
            entityId: expert.id,
            schemaVersion: '1',
            source: 'discovery-v2',
            privacyClass: 'derived_non_content',
            payload: {
              queryId: impression.queryId,
              rankPosition: ranked.indexOf(expert) + 1,
              baselineScore: expert.matchScore
            },
            provenance: { rankingVersion: 'weighted-explainable-v1' }
          }
        })
      }
      return { ranked, impression }
    })
    res.json({
      success: true,
      queryId: experts.impression.queryId,
      count: experts.ranked.length,
      experts: experts.ranked,
      ranking: { version: 1, method: 'weighted_explainable_baseline' },
      source: 'durable_profile_index',
      impressionCapture: experts.impression
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/engagements', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable engagements require a ready PostgreSQL database')
    }

    const engagement = await transaction((client) => createEngagementContext({
      client,
      input: {
        clientWallet: req.walletAddress,
        providerWallet: req.body.providerWallet,
        searchBrief: req.body.searchBrief,
        discoveryContext: req.body.discoveryContext,
        rankingExplanation: req.body.rankingExplanation,
        proposedTerms: req.body.proposedTerms,
        matchSessionId: req.body.matchSessionId
      }
    }))
    res.status(201).json({ success: true, engagement, source: 'durable_engagement_context' })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/engagements/:engagementId', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable engagements require a ready PostgreSQL database')
    }
    const engagement = await transaction((client) => getEngagementContext({
      client,
      engagementId: req.params.engagementId,
      walletAddress: req.walletAddress
    }))
    res.json({ success: true, engagement, source: 'durable_engagement_context' })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/engagements/:engagementId/payment-state', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'engagement payment state requires a ready PostgreSQL database')
    }
    const paymentState = await transaction((client) => getEngagementPaymentState({
      client,
      engagementId: req.params.engagementId,
      walletAddress: req.walletAddress,
      maxVerifierCursorAgeMs: config.payments.verifierCursorMaxAgeMs
    }))
    res.json({ success: true, paymentState, source: 'verifier_owned_payment_state' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/engagements/:engagementId/collaboration-state', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable engagements require a ready PostgreSQL database')
    }
    const engagement = await transaction((client) => updateCollaborationState({
      client,
      engagementId: req.params.engagementId,
      walletAddress: req.walletAddress,
      status: req.body.status
    }))
    res.json({ success: true, engagement, source: 'durable_engagement_context' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/engagements/:engagementId/payment-intent', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable engagements require a ready PostgreSQL database')
    }
    const engagement = await transaction((client) => attachPaymentIntentToEngagement({
      client,
      engagementId: req.params.engagementId,
      walletAddress: req.walletAddress,
      paymentIntentId: req.body.paymentIntentId
    }))
    res.json({ success: true, engagement, source: 'durable_engagement_context', paymentState: 'intent_created' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/engagements/:engagementId/outcomes', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable outcomes require a ready PostgreSQL database')
    }
    const result = await transaction((client) => recordOutcome({
      client,
      input: {
        engagementId: req.params.engagementId,
        walletAddress: req.walletAddress,
        eventType: req.body.eventType,
        evidenceType: req.body.evidenceType,
        evidenceId: req.body.evidenceId,
        payload: req.body.payload,
        occurredAt: req.body.occurredAt
      }
    }))
    res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      ...result,
      verificationStatus: 'unverified',
      source: 'participant_report'
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/outcomes/:outcomeId/verify', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'outcome verification requires a ready PostgreSQL database')
    }
    const result = await transaction((client) => verifyOutcome({
      client,
      outcomeId: req.params.outcomeId,
      verifierId: req.walletAddress,
      verificationStatus: req.body.verificationStatus || 'verified',
      verificationEvidence: req.body.verificationEvidence || {}
    }))
    res.status(result.idempotentReplay ? 200 : 200).json({
      success: true,
      ...result,
      source: 'verifier_owned_outcome_evidence',
      authority: 'verified_evidence_only'
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/ops/trust-signals', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'verified trust signals require a ready PostgreSQL database')
    }
    const signals = await transaction((client) => listVerifiedTrustSignals({
      client,
      subjectWalletAddress: req.query.subjectWallet,
      signalType: req.query.signalType,
      limit: req.query.limit,
      offset: req.query.offset
    }))
    res.json({ success: true, ...signals })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/pilot/metrics', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'pilot metrics require a ready PostgreSQL database')
    }
    const metrics = await transaction((client) => getPilotMetrics({
      client,
      from: req.query.from || null,
      to: req.query.to || null
    }))
    res.json({ success: true, metrics })
  } catch (error) {
    next(error)
  }
})

app.post('/api/v2/payment-intents', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable payment intents require a ready PostgreSQL database')
    }

    const result = await transaction((client) => createPaymentIntentV2({
      client,
      tokenRegistry: paymentTokenRegistry,
      input: {
        senderWallet: req.walletAddress,
        recipientWallet: req.body.recipientWallet,
        chainId: req.body.chainId || config.payments.settlementChainId,
        tokenAddress: req.body.tokenAddress,
        amountBaseUnits: req.body.amountBaseUnits,
        ratePerSecondBaseUnits: req.body.ratePerSecondBaseUnits,
        idempotencyKey: req.headers['x-idempotency-key'] || req.body.idempotencyKey,
        engagementId: req.body.engagementId
      }
    }))

    res.status(result.idempotentReplay ? 200 : 201).json({
      success: true,
      ...result
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/payment-intents/:intentId', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable payment intents require a ready PostgreSQL database')
    }

    const intent = await transaction((client) => getPaymentIntentV2({
      client,
      intentId: req.params.intentId,
      walletAddress: req.walletAddress
    }))
    res.json({ success: true, intent, source: 'durable_payment_intent', finalityStatus: 'unverified' })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/streams', authenticateToken, async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      throw new ExternalServiceError('Database', 'durable payment streams require a ready PostgreSQL database')
    }

    const streams = await transaction((client) => listPaymentStreamsV2({
      client,
      walletAddress: req.walletAddress
    }))
    res.json({ success: true, count: streams.length, streams, source: 'durable_payment_projection' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams', authenticateToken, (req, res, next) => {
  try {
    assertLegacyPaymentMutationAllowed({ isProd: config.isProd })
    const chainId = Number.parseInt(req.body.chainId || String(config.payments.settlementChainId), 10)
    if (!Number.isFinite(chainId)) {
      throw new ValidationError('Chain id must be an integer')
    }

    if (!chainRegistry.get(String(chainId))?.enabled) {
      throw new ValidationError('Requested chain is not enabled')
    }

    const validated = validate(
      {
        recipient: schemas.wallet.address,
        token: schemas.payment.token,
        amount: schemas.payment.amount,
        duration: schemas.payment.duration
      },
      {
        recipient: req.body.recipientWallet,
        token: req.body.token,
        amount: req.body.amount,
        duration: req.body.duration
      }
    )

    const idempotencyKey = getIdempotencyKey(req)
    const createFingerprint = fingerprintPaymentCreateRequest(req.walletAddress, chainId, validated)

    if (idempotencyKey) {
      const existing = paymentCreateIdempotency.get(idempotencyKey)
      if (existing) {
        if (existing.ownerWallet !== req.walletAddress || existing.fingerprint !== createFingerprint) {
          throw new ConflictError('Idempotency key reuse with different payment request')
        }

        const existingStream = paymentStreams.get(existing.streamId)
        if (!existingStream) {
          throw new AppError('Idempotent stream reference is missing', 500)
        }

        return res.json({
          success: true,
          stream: existingStream,
          uxState: existingStream.confirmationState,
          risk: existing.risk,
          idempotentReplay: true,
          idempotencyKey
        })
      }
    }

    const riskCheck = scorePaymentRisk({
      senderWallet: req.walletAddress,
      recipientWallet: validated.recipient,
      amount: validated.amount,
      duration: validated.duration,
      chainId
    })

    if (riskCheck.severity === 'high') {
      throw new AuthorizationError(`Payment blocked by risk engine: ${riskCheck.flags.join(', ')}`)
    }

    const streamId = String(paymentStreams.size + 1)
    const stream = {
      id: streamId,
      senderWallet: req.walletAddress,
      recipientWallet: validated.recipient,
      token: validated.token,
      amount: validated.amount,
      duration: validated.duration,
      chainId,
      start_time: nowSeconds(),
      stop_time: nowSeconds() + validated.duration,
      status: 'active',
      confirmationState: 'submitted',
      submittedAt: nowIso(),
      includedAt: null,
      reflectedAt: null,
      withdrawn: 0,
      createdAt: nowIso()
    }

    paymentStreams.set(streamId, stream)

    if (idempotencyKey) {
      paymentCreateIdempotency.set(idempotencyKey, {
        ownerWallet: req.walletAddress,
        fingerprint: createFingerprint,
        streamId,
        risk: riskCheck,
        createdAt: nowIso()
      })
    }

    markStateDirty()
    res.json({
      success: true,
      stream,
      uxState: stream.confirmationState,
      risk: riskCheck,
      idempotentReplay: false,
      idempotencyKey
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/payments/streams', authenticateToken, (req, res) => {
  const streams = Array.from(paymentStreams.values()).filter((stream) => stream.senderWallet === req.walletAddress || stream.recipientWallet === req.walletAddress)
  res.json({ success: true, count: streams.length, streams })
})

app.get('/api/payments/streams/:streamId', authenticateToken, (req, res, next) => {
  try {
    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamAccess(stream, req.walletAddress, 'view')

    res.json({ success: true, stream })
  } catch (error) {
    next(error)
  }
})

app.get('/api/payments/streams/:streamId/stats', authenticateToken, (req, res, next) => {
  try {
    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamAccess(stream, req.walletAddress, 'view')

    const streamed = calculateStreamedAmount(stream)

    res.json({
      success: true,
      stats: {
        streamId: stream.id,
        chainId: stream.chainId,
        total: stream.amount,
        streamed,
        available: Math.max(0, streamed - stream.withdrawn),
        withdrawn: stream.withdrawn,
        progress: stream.amount > 0 ? (streamed / stream.amount) * 100 : 0,
        uxState: stream.confirmationState,
        timestamps: {
          submittedAt: stream.submittedAt,
          includedAt: stream.includedAt,
          reflectedAt: stream.reflectedAt
        }
      }
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams/:streamId/confirm', authenticateToken, async (req, res, next) => {
  try {
    assertLegacyPaymentMutationAllowed({ isProd: config.isProd })
    if (!config.payments.allowLegacyConfirmations) {
      throw new AuthorizationError('Legacy payment confirmation simulation is disabled; verified chain events must update stream finality')
    }

    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamAccess(stream, req.walletAddress, 'confirm')

    const state = String(req.body.state || '').toLowerCase()
    if (!['included', 'reflected'].includes(state)) {
      throw new ValidationError('State must be included or reflected')
    }

    if (stream.confirmationState === 'reflected') {
      throw new ConflictError('Stream is already reflected')
    }

    if (state === 'included') {
      if (stream.confirmationState !== 'submitted') {
        throw new ConflictError(`Cannot transition from ${stream.confirmationState} to included`)
      }

      stream.confirmationState = 'included'
      stream.includedAt = nowIso()
    }

    if (state === 'reflected') {
      if (stream.confirmationState !== 'included') {
        throw new ConflictError(`Cannot transition from ${stream.confirmationState} to reflected`)
      }

      if (!stream.includedAt) {
        throw new ValidationError('Stream must be included before reflection')
      }
      stream.confirmationState = 'reflected'
      stream.reflectedAt = nowIso()

      await enqueueWebhookDeliveries('payment.stream.reflected', {
        streamId: stream.id,
        senderWallet: stream.senderWallet,
        recipientWallet: stream.recipientWallet,
        amount: stream.amount,
        token: stream.token,
        chainId: stream.chainId,
        reflectedAt: stream.reflectedAt
      })
    }

    paymentStreams.set(stream.id, stream)
    markStateDirty()
    res.json({
      success: true,
      streamId: stream.id,
      uxState: stream.confirmationState,
      source: 'legacy_development_simulation',
      finalityStatus: 'unverified'
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams/:streamId/withdraw', authenticateToken, (req, res, next) => {
  try {
    assertLegacyPaymentMutationAllowed({ isProd: config.isProd })
    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamRecipient(stream, req.walletAddress, 'withdraw from')

    const amount = schemas.payment.amount(req.body.amount)
    const streamed = calculateStreamedAmount(stream)
    const available = Math.max(0, streamed - stream.withdrawn)

    if (amount > available) {
      throw new RateLimitError(`Insufficient available balance: ${available}`)
    }

    stream.withdrawn += amount
    paymentStreams.set(stream.id, stream)
    markStateDirty()

    res.json({ success: true, streamId: stream.id, amount })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams/:streamId/cancel', authenticateToken, (req, res, next) => {
  try {
    assertLegacyPaymentMutationAllowed({ isProd: config.isProd })
    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamAccess(stream, req.walletAddress, 'cancel')

    stream.status = 'cancelled'
    paymentStreams.set(stream.id, stream)
    markStateDirty()

    res.json({ success: true, streamId: stream.id })
  } catch (error) {
    next(error)
  }
})

app.post('/api/calls', authenticateToken, (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.body.recipientWallet)
    const roomName = req.body.roomName || `call-${Date.now()}`

    const call = {
      id: String(calls.size + 1),
      callerWallet: req.walletAddress,
      recipientWallet: wallet,
      roomName,
      status: 'pending',
      createdAt: nowIso()
    }

    calls.set(call.id, call)
    markStateDirty()
    res.json({ success: true, call })
  } catch (error) {
    next(error)
  }
})

app.post('/api/contracts', authenticateToken, (req, res, next) => {
  try {
    const expertWallet = schemas.wallet.address(req.body.expertWallet)
    const pricingMode = String(req.body.pricingMode || '').toLowerCase()
    if (!['hourly', 'fixed'].includes(pricingMode)) {
      throw new ValidationError('pricingMode must be hourly or fixed')
    }

    const rate = Number(req.body.rate)
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new ValidationError('rate must be a positive number')
    }

    const currency = String(req.body.currency || 'USDC').toUpperCase()
    const scope = String(req.body.scope || '').trim()
    if (!scope) {
      throw new ValidationError('scope is required')
    }

    const expectedDuration = Number(req.body.expectedDuration || 0)
    const cancellationPolicy = String(req.body.cancellationPolicy || 'none').toLowerCase()

    const contract = {
      id: String(engagementContracts.size + 1),
      clientWallet: req.walletAddress,
      expertWallet,
      scope,
      pricingMode,
      rate,
      currency,
      expectedDuration,
      cancellationPolicy,
      status: 'active',
      createdAt: nowIso(),
      closedAt: null,
      outcome: null,
      disputeReason: null
    }

    engagementContracts.set(contract.id, contract)
    markStateDirty()
    res.json({ success: true, contract })
  } catch (error) {
    next(error)
  }
})

app.get('/api/contracts/:id', authenticateToken, (req, res, next) => {
  try {
    const contract = engagementContracts.get(req.params.id)
    if (!contract) {
      throw new NotFoundError('Contract')
    }

    if (contract.clientWallet !== req.walletAddress && contract.expertWallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot view this contract')
    }

    res.json({ success: true, contract })
  } catch (error) {
    next(error)
  }
})

app.post('/api/contracts/:id/close', authenticateToken, async (req, res, next) => {
  try {
    const contract = engagementContracts.get(req.params.id)
    if (!contract) {
      throw new NotFoundError('Contract')
    }

    if (contract.clientWallet !== req.walletAddress && contract.expertWallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot close this contract')
    }

    if (contract.status !== 'active') {
      throw new ConflictError(`Cannot close a contract in status: ${contract.status}`)
    }

    const outcome = String(req.body.outcome || '').toLowerCase()
    if (!['completed', 'cancelled', 'no_show'].includes(outcome)) {
      throw new ValidationError('outcome must be completed, cancelled, or no_show')
    }

    const paidMinutes = Number(req.body.paidMinutes || 0)

    contract.status = 'closed'
    contract.outcome = outcome
    contract.closedAt = nowIso()

    const reputationEvent = {
      id: String(reputationEvents.length + 1),
      wallet: contract.expertWallet,
      sessionId: null,
      streamId: req.body.streamId ? String(req.body.streamId) : null,
      outcome,
      paidMinutes,
      repeatBooking: Boolean(req.body.repeatBooking),
      disputed: outcome === 'no_show',
      expertise: safeArray(req.body.expertise).map((item) => String(item).toLowerCase()),
      contractId: contract.id,
      createdAt: nowIso()
    }

    reputationEvents.push(reputationEvent)
    recomputeRankingEvaluation()

    markStateDirty()

    await enqueueWebhookDeliveries('contract.closed', {
      contractId: contract.id,
      outcome,
      expertWallet: contract.expertWallet,
      clientWallet: contract.clientWallet,
      closedAt: contract.closedAt
    })

    res.json({ success: true, contract, reputationEvent })
  } catch (error) {
    next(error)
  }
})

app.post('/api/contracts/:id/dispute', authenticateToken, async (req, res, next) => {
  try {
    const contract = engagementContracts.get(req.params.id)
    if (!contract) {
      throw new NotFoundError('Contract')
    }

    if (contract.clientWallet !== req.walletAddress && contract.expertWallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot dispute this contract')
    }

    if (contract.status !== 'active') {
      throw new ConflictError(`Cannot dispute a contract in status: ${contract.status}`)
    }

    const reason = String(req.body.reason || '').trim()
    if (!reason) {
      throw new ValidationError('reason is required')
    }

    contract.status = 'disputed'
    contract.disputeReason = reason
    markStateDirty()

    await enqueueWebhookDeliveries('contract.disputed', {
      contractId: contract.id,
      reason,
      expertWallet: contract.expertWallet,
      clientWallet: contract.clientWallet,
      disputedAt: nowIso()
    })

    res.json({ success: true, contract })
  } catch (error) {
    next(error)
  }
})

app.post('/api/trust/signals', authenticateToken, requireScopes('admin:*'), (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.body.wallet)
    const type = String(req.body.type || '').toLowerCase()
    if (!['fraud_flag', 'dispute_record', 'verification_failure', 'manual_review'].includes(type)) {
      throw new ValidationError('type must be fraud_flag, dispute_record, verification_failure, or manual_review')
    }

    const severity = String(req.body.severity || 'medium').toLowerCase()
    if (!['low', 'medium', 'high'].includes(severity)) {
      throw new ValidationError('severity must be low, medium, or high')
    }

    const reason = String(req.body.reason || '').trim()
    if (!reason) {
      throw new ValidationError('reason is required')
    }

    const signal = {
      id: String(trustSignals.size + 1),
      wallet,
      type,
      severity,
      reason,
      status: 'open',
      createdBy: req.walletAddress,
      createdAt: nowIso(),
      resolvedAt: null,
      resolution: null
    }

    trustSignals.set(signal.id, signal)
    markStateDirty()
    res.json({ success: true, signal })
  } catch (error) {
    next(error)
  }
})

app.get('/api/trust/signals/:wallet', authenticateToken, (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)
    const isAdmin = safeArray(req.scopes).some((scope) => hasScope([scope], 'admin:*'))

    if (!isAdmin && wallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot view trust signals for another wallet')
    }

    const signals = Array.from(trustSignals.values()).filter((signal) => signal.wallet === wallet)
    res.json({ success: true, wallet, signals, count: signals.length })
  } catch (error) {
    next(error)
  }
})

app.post('/api/trust/signals/:id/resolve', authenticateToken, requireScopes('admin:*'), (req, res, next) => {
  try {
    const signal = trustSignals.get(req.params.id)
    if (!signal) {
      throw new NotFoundError('Trust signal')
    }

    if (signal.status !== 'open') {
      throw new ConflictError(`Signal is already ${signal.status}`)
    }

    const resolution = String(req.body.resolution || '').trim()
    if (!resolution) {
      throw new ValidationError('resolution is required')
    }

    signal.status = 'resolved'
    signal.resolution = resolution
    signal.resolvedAt = nowIso()
    markStateDirty()
    res.json({ success: true, signal })
  } catch (error) {
    next(error)
  }
})

app.post('/api/intelligence/ranking/train', authenticateToken, requireScopes('intelligence:*'), (req, res, next) => {
  try {
    const model = trainRankingModelFromOutcomes()
    res.json({ success: true, model })
  } catch (error) {
    next(error)
  }
})

app.get('/api/intelligence/ranking/model', authenticateToken, requireScopes('intelligence:*'), (req, res) => {
  res.json({ success: true, model: rankingModel, evaluation: evaluateRankingModel() })
})

app.post('/api/intelligence/ranking/evaluate', authenticateToken, requireScopes('intelligence:*'), (req, res, next) => {
  try {
    const evaluation = evaluateRankingModel()
    res.json({ success: true, evaluation })
  } catch (error) {
    next(error)
  }
})

app.post('/api/intelligence/conversations/:threadId/assist', authenticateToken, requireScopes('intelligence:*'), (req, res, next) => {
  try {
    const thread = conversationThreads.get(req.params.threadId)
    if (!thread) {
      throw new NotFoundError('Conversation thread')
    }

    if (!thread.participants.includes(req.walletAddress)) {
      throw new AuthorizationError('Cannot assist this thread')
    }

    const assistance = buildConversationAssist(thread)
    res.json({ success: true, threadId: thread.id, assistance })
  } catch (error) {
    next(error)
  }
})

app.post('/api/intelligence/conversations/:threadId/synthesize', authenticateToken, requireScopes('intelligence:*'), (req, res, next) => {
  try {
    const thread = conversationThreads.get(req.params.threadId)
    if (!thread) {
      throw new NotFoundError('Conversation thread')
    }

    if (!thread.participants.includes(req.walletAddress)) {
      throw new AuthorizationError('Cannot synthesize this thread')
    }

    const messages = safeArray(thread.messages)
    const text = messages.map((item) => String(item.text || '')).join(' ').toLowerCase()
    const wordCounts = {}
    for (const word of text.split(/\W+/).filter((word) => word.length > 4)) {
      wordCounts[word] = (wordCounts[word] || 0) + 1
    }

    const topWords = Object.entries(wordCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word)

    const keyTopics = topWords.length > 0 ? topWords : ['general']
    const actionItems = messages
      .filter((item) => /\b(todo|action|follow.?up|need|must|should|will|next step|review|send|share|complete)\b/i.test(item.text || ''))
      .map((item) => String(item.text).slice(0, 120))
      .slice(0, 5)

    const synthesis = {
      threadId: thread.id,
      participants: thread.participants,
      messageCount: messages.length,
      keyTopics,
      actionItems,
      suggestedFollowUp: messages.length > 0
        ? `Schedule follow-up with ${thread.participants.filter((w) => w !== req.walletAddress)[0] || 'participant'}`
        : 'No messages to synthesize',
      synthesizedAt: nowIso()
    }

    res.json({ success: true, synthesis })
  } catch (error) {
    next(error)
  }
})

app.post('/api/intelligence/risk/payments/score', authenticateToken, requireScopes('intelligence:*'), (req, res, next) => {
  try {
    let payload = null

    if (req.body.streamId) {
      const stream = paymentStreams.get(String(req.body.streamId))
      if (!stream) {
        throw new NotFoundError('Stream')
      }

      assertStreamAccess(stream, req.walletAddress, 'score risk for')
      payload = {
        senderWallet: stream.senderWallet,
        recipientWallet: stream.recipientWallet,
        amount: stream.amount,
        duration: stream.duration,
        chainId: stream.chainId
      }
    } else {
      const recipientWallet = schemas.wallet.address(req.body.recipientWallet)
      payload = {
        senderWallet: req.walletAddress,
        recipientWallet,
        amount: schemas.payment.amount(req.body.amount),
        duration: schemas.payment.duration(req.body.duration),
        chainId: Number.parseInt(req.body.chainId || String(config.payments.settlementChainId), 10)
      }
    }

    const score = scorePaymentRisk(payload)
    res.json({ success: true, score })
  } catch (error) {
    next(error)
  }
})

app.get('/api/ops/slo', authenticateToken, requireScopes('ops:*'), (req, res) => {
  const latencyP95 = percentile(requestMetrics.latencies, 95)
  const availability = requestMetrics.total === 0 ? 100 : Number((((requestMetrics.total - requestMetrics.errors) / requestMetrics.total) * 100).toFixed(2))
  const operations = computeOperationalBacklogMetrics()

  res.json({
    success: true,
    slo: {
      availabilityPct: availability,
      p95LatencyMs: latencyP95,
      targets: {
        availabilityPct: config.observability.availabilityTargetPct,
        p95LatencyMs: config.observability.p95LatencyTargetMs
      },
      meetsTarget: availability >= config.observability.availabilityTargetPct && latencyP95 <= config.observability.p95LatencyTargetMs,
      auth: {
        challengesIssued: requestMetrics.auth.challengesIssued,
        challengeRateLimited: requestMetrics.auth.challengeRateLimited,
        loginSuccess: requestMetrics.auth.loginSuccess,
        loginFailed: requestMetrics.auth.loginFailed,
        loginRateLimited: requestMetrics.auth.loginRateLimited
      },
      walletVerification: {
        challengesIssued: requestMetrics.walletVerification.challengesIssued,
        challengeRateLimited: requestMetrics.walletVerification.challengeRateLimited,
        verifySuccess: requestMetrics.walletVerification.verifySuccess,
        verifyFailed: requestMetrics.walletVerification.verifyFailed,
        verifyRateLimited: requestMetrics.walletVerification.verifyRateLimited
      },
      operations
    }
  })
})

app.post('/api/ops/chains/enable', authenticateToken, requireScopes('ops:*'), (req, res, next) => {
  try {
    const chainId = Number.parseInt(req.body.chainId, 10)
    if (!Number.isFinite(chainId)) {
      throw new ValidationError('Chain id must be an integer')
    }

    const reliability = computeReliabilityMetrics()
    if (reliability.totalStreams < config.payments.reliabilityMinSamples) {
      throw new AppError(
        `Insufficient reliability evidence: ${reliability.totalStreams} streams < ${config.payments.reliabilityMinSamples} required`,
        409
      )
    }

    if (reliability.reliabilityPct < config.payments.reliabilityTargetPct) {
      throw new AppError(`Reliability target not met: ${reliability.reliabilityPct}% < ${config.payments.reliabilityTargetPct}%`, 409)
    }

    chainRegistry.set(String(chainId), {
      enabled: true,
      reason: req.body.reason || 'reliability gate passed',
      enabledAt: nowIso()
    })

    res.json({ success: true, chainId, reliability })
  } catch (error) {
    next(error)
  }
})

app.get('/api/ops/chains', authenticateToken, requireScopes('ops:*'), (req, res) => {
  res.json({ success: true, chains: Object.fromEntries(chainRegistry.entries()) })
})

app.post('/api/ops/queue/jobs', authenticateToken, requireScopes('ops:*'), (req, res, next) => {
  try {
    const type = String(req.body.type || '').trim()
    if (!type) {
      throw new ValidationError('Job type is required')
    }

    const id = String(queueJobs.size + 1)
    const job = {
      id,
      ownerWallet: req.walletAddress,
      type,
      payload: req.body.payload || {},
      status: 'pending',
      attempts: 0,
      maxAttempts: Number(req.body.maxAttempts || 3),
      createdAt: nowIso(),
      updatedAt: nowIso()
    }
    queueJobs.set(id, job)
    markStateDirty()

    res.json({ success: true, job })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ops/queue/process', authenticateToken, requireScopes('ops:*'), (req, res) => {
  const results = []
  const isAdmin = hasScope(safeArray(req.scopes), 'admin:*')

  for (const job of queueJobs.values()) {
    if (!['pending', 'failed'].includes(job.status)) continue
    if (!canManageQueueJob(job, req.walletAddress, isAdmin)) continue

    job.attempts += 1
    job.updatedAt = nowIso()
    job.status = 'processing'

    try {
      if (job.type === 'reconcile_stream') {
        const stream = paymentStreams.get(String(job.payload.streamId))
        if (!stream) {
          throw new Error('stream_missing')
        }
        if (stream.withdrawn > calculateStreamedAmount(stream)) {
          throw new Error('withdrawn_exceeds_streamed')
        }
      }

      job.status = 'completed'
      results.push({ id: job.id, status: job.status })
    } catch (error) {
      job.status = job.attempts >= job.maxAttempts ? 'dead' : 'failed'
      job.lastError = error.message
      results.push({ id: job.id, status: job.status, error: job.lastError })
    }
  }

  if (results.length > 0) {
    markStateDirty()
  }

  res.json({ success: true, processed: results.length, results })
})

app.get('/api/ops/queue/jobs', authenticateToken, requireScopes('ops:*'), (req, res) => {
  const isAdmin = hasScope(safeArray(req.scopes), 'admin:*')
  const jobs = Array.from(queueJobs.values()).filter((job) => canManageQueueJob(job, req.walletAddress, isAdmin))
  res.json({ success: true, count: jobs.length, jobs })
})

app.post('/api/ops/queue/jobs/:jobId/retry', authenticateToken, requireScopes('ops:*'), (req, res, next) => {
  try {
    const job = queueJobs.get(String(req.params.jobId))
    if (!job) {
      throw new NotFoundError('Queue job')
    }

    const isAdmin = hasScope(safeArray(req.scopes), 'admin:*')
    if (!canManageQueueJob(job, req.walletAddress, isAdmin)) {
      throw new AuthorizationError('Cannot retry this queue job')
    }

    if (!['failed', 'dead'].includes(job.status)) {
      throw new ConflictError(`Queue job in ${job.status} state cannot be retried`)
    }

    job.status = 'pending'
    job.attempts = 0
    job.lastError = null
    job.updatedAt = nowIso()
    queueJobs.set(job.id, job)
    markStateDirty()

    res.json({ success: true, job })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ops/reconciliation/run', authenticateToken, requireScopes('ops:*'), (req, res) => {
  const report = []

  for (const stream of paymentStreams.values()) {
    const streamed = calculateStreamedAmount(stream)
    const status = {
      streamId: stream.id,
      confirmationState: stream.confirmationState,
      consistent: true,
      reasons: []
    }

    if (stream.withdrawn > streamed) {
      status.consistent = false
      status.reasons.push('withdrawn_exceeds_streamed')
    }

    if (stream.confirmationState === 'reflected' && !stream.includedAt) {
      status.consistent = false
      status.reasons.push('reflected_without_inclusion')
    }

    report.push(status)

    if (!status.consistent) {
      const jobId = String(queueJobs.size + 1)
      queueJobs.set(jobId, {
        id: jobId,
        ownerWallet: null,
        type: 'reconcile_stream',
        payload: { streamId: stream.id },
        status: 'pending',
        attempts: 0,
        maxAttempts: 3,
        createdAt: nowIso(),
        updatedAt: nowIso()
      })
      markStateDirty()
    }
  }

  const inconsistent = report.filter((item) => item.consistent === false).length
  res.json({ success: true, total: report.length, inconsistent, report })
})

app.get('/api/v2/extensions/openapi.json', (req, res) => {
  res.type('application/json').json(getExtensionOpenApiDocument())
})

app.get('/api/v2/extensions/contracts', authenticateToken, requireScopes('extensions:*'), (req, res) => {
  res.json({ success: true, contracts: getExtensionContractCapabilities() })
})

app.post('/api/v2/extensions/hooks', authenticateToken, requireScopes('extensions:*'), async (req, res, next) => {
  try {
    const databaseReady = getDatabaseStatus() === 'ready'
    if (!databaseReady && config.isProd) {
      throw new ExternalServiceError('Database', 'v2 extension hooks require a ready PostgreSQL database')
    }
    const callbackUrl = validateWebhookUrl(req.body.callbackUrl)
    await assertSafeWebhookUrl(callbackUrl)
    const contract = normalizeExtensionHookInput({
      event: req.body.event,
      callbackUrl,
      projections: req.body.projections,
      apiVersion: req.body.apiVersion || 'v2',
      replayWindowSeconds: req.body.replayWindowSeconds
    })
    if (!databaseReady) {
      const id = String(extensionHooks.size + 1)
      const hook = { id, ownerWallet: req.walletAddress, ...contract, createdAt: nowIso() }
      extensionHooks.set(id, hook)
      markStateDirty()
      return res.json({ success: true, hook, persistence: 'process_local_development_fallback' })
    }
    const hook = await transaction((client) => registerExtensionHook({ client, ownerWallet: req.walletAddress, hook: contract }))
    res.json({ success: true, hook, persistence: 'postgresql_durable' })
  } catch (error) {
    next(error)
  }
})

app.get('/api/v2/extensions/hooks', authenticateToken, requireScopes('extensions:*'), async (req, res, next) => {
  try {
    if (getDatabaseStatus() !== 'ready') {
      if (config.isProd) throw new ExternalServiceError('Database', 'v2 extension hooks require a ready PostgreSQL database')
      const hooks = Array.from(extensionHooks.values()).filter((hook) => hook.apiVersion === 'v2' && hook.ownerWallet === req.walletAddress)
      return res.json({ success: true, apiVersion: 'v2', count: hooks.length, hooks, persistence: 'process_local_development_fallback' })
    }
    const hooks = await transaction((client) => listExtensionHooks({ client, ownerWallet: req.walletAddress }))
    res.json({ success: true, apiVersion: 'v2', count: hooks.length, hooks, persistence: 'postgresql_durable' })
  } catch (error) {
    next(error)
  }
})

app.post('/api/extensions/hooks', authenticateToken, requireScopes('extensions:*'), async (req, res, next) => {
  try {
    const event = String(req.body.event || '').trim()
    if (!event) {
      throw new ValidationError('Event is required')
    }

    const callbackUrl = validateWebhookUrl(req.body.callbackUrl)
    await assertSafeWebhookUrl(callbackUrl)

    const id = String(extensionHooks.size + 1)
    const hook = {
      id,
      ownerWallet: req.walletAddress,
      event,
      callbackUrl,
      createdAt: nowIso()
    }
    extensionHooks.set(id, hook)
    markStateDirty()

    res.json({ success: true, hook })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ops/webhooks/process', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    const dryRun = req.body.dryRun !== false
    const isAdmin = hasScope(safeArray(req.scopes), 'admin:*')
    const results = await processWebhookDeliveries({
      dryRun,
      canProcessDelivery: (delivery) => isAdmin || getDeliveryOwnerWallet(delivery) === req.walletAddress
    })
    res.json({ success: true, dryRun, processed: results.length, results })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ops/webhooks/deliveries/:deliveryId/retry', authenticateToken, requireScopes('ops:*'), (req, res, next) => {
  try {
    const delivery = webhookDeliveries.get(String(req.params.deliveryId))
    if (!delivery) {
      throw new NotFoundError('Webhook delivery')
    }

    const isAdmin = hasScope(safeArray(req.scopes), 'admin:*')
    if (!isAdmin && getDeliveryOwnerWallet(delivery) !== req.walletAddress) {
      throw new AuthorizationError('Cannot retry this webhook delivery')
    }

    if (!['failed', 'dead'].includes(delivery.status)) {
      throw new ConflictError(`Webhook delivery in ${delivery.status} state cannot be retried`)
    }

    delivery.status = 'pending'
    delivery.attempts = 0
    delivery.lastError = null
    delivery.nextAttemptAt = nowIso()
    delivery.updatedAt = nowIso()
    webhookDeliveries.set(delivery.id, delivery)
    markStateDirty()

    res.json({ success: true, delivery })
  } catch (error) {
    next(error)
  }
})

app.get('/api/ops/webhooks/deliveries', authenticateToken, requireScopes('ops:*'), (req, res) => {
  const isAdmin = hasScope(safeArray(req.scopes), 'admin:*')
  const deliveries = Array.from(webhookDeliveries.values()).filter((delivery) => {
    if (isAdmin) return true
    return getDeliveryOwnerWallet(delivery) === req.walletAddress
  })

  res.json({ success: true, count: deliveries.length, deliveries })
})

app.post('/api/ops/state/persist', authenticateToken, requireScopes('ops:*'), async (req, res, next) => {
  try {
    const persisted = await flushStateSnapshot(true)
    res.json({ success: true, persisted, path: config.state.filePath })
  } catch (error) {
    next(error)
  }
})

app.get('/api/extensions/hooks', authenticateToken, requireScopes('extensions:*'), (req, res) => {
  const hooks = Array.from(extensionHooks.values()).filter((hook) => hook.ownerWallet === req.walletAddress)
  res.json({ success: true, count: hooks.length, hooks })
})

// ── Ledger ──────────────────────────────────────────────────────────────────

app.get('/api/ledger/:wallet', authenticateToken, (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)
    const isAdmin = hasScope(safeArray(req.scopes), 'admin:*')
    if (!isAdmin && wallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot view ledger for another wallet')
    }
    const entries = Array.from(offchainLedger.values()).filter((e) => e.wallet === wallet.toLowerCase())
    res.json({ success: true, wallet, entries, count: entries.length })
  } catch (error) {
    next(error)
  }
})

app.post('/api/ops/ledger/reconcile', authenticateToken, requireScopes('ops:*'), (req, res) => {
  const credited = []
  for (const stream of paymentStreams.values()) {
    if (stream.confirmationState !== 'reflected' || stream.ledgerReconciledAt) {
      continue
    }

    applyLedgerDelta(stream.recipientWallet, stream.chainId, { settled: stream.amount })
    const senderEntry = getLedgerEntry(stream.senderWallet, stream.chainId)
    senderEntry.settledBalance = Math.max(0, senderEntry.settledBalance - stream.amount)
    senderEntry.updatedAt = nowIso()
    stream.ledgerReconciledAt = nowIso()
    paymentStreams.set(stream.id, stream)
    credited.push({
      streamId: stream.id,
      amount: stream.amount,
      currency: stream.token,
      chainId: stream.chainId,
      reconciledAt: stream.ledgerReconciledAt
    })
  }

  if (credited.length > 0) {
    markStateDirty()
  }

  res.json({ success: true, reconciled: credited.length, entries: credited })
})

// ── Payment Disputes ─────────────────────────────────────────────────────────

app.post('/api/payments/streams/:streamId/dispute', authenticateToken, (req, res, next) => {
  try {
    assertLegacyPaymentMutationAllowed({ isProd: config.isProd })
    const stream = paymentStreams.get(req.params.streamId)
    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamAccess(stream, req.walletAddress, 'dispute')

    if (stream.disputeState) {
      throw new ConflictError('Stream already has an open dispute')
    }

    const reason = String(req.body.reason || '').trim()
    if (!reason) {
      throw new ValidationError('reason is required')
    }

    stream.disputeState = {
      status: 'open',
      reason,
      raisedBy: req.walletAddress,
      raisedAt: nowIso(),
      resolvedAt: null,
      resolution: null
    }

    const signalId = String(trustSignals.size + 1)
    const counterparty = req.walletAddress === stream.senderWallet ? stream.recipientWallet : stream.senderWallet
    trustSignals.set(signalId, {
      id: signalId,
      wallet: counterparty,
      type: 'dispute_record',
      severity: 'medium',
      reason: `Payment stream ${stream.id} disputed: ${reason}`,
      status: 'open',
      createdBy: req.walletAddress,
      createdAt: nowIso(),
      resolvedAt: null,
      resolution: null
    })

    markStateDirty()
    res.json({ success: true, stream, disputeState: stream.disputeState })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams/:streamId/dispute/resolve', authenticateToken, requireScopes('admin:*'), (req, res, next) => {
  try {
    assertLegacyPaymentMutationAllowed({ isProd: config.isProd })
    const stream = paymentStreams.get(req.params.streamId)
    if (!stream) {
      throw new NotFoundError('Stream')
    }

    if (!stream.disputeState || stream.disputeState.status !== 'open') {
      throw new ConflictError('No open dispute on this stream')
    }

    const resolution = String(req.body.resolution || '').trim()
    if (!resolution) {
      throw new ValidationError('resolution is required')
    }

    const outcome = String(req.body.outcome || 'resolved').toLowerCase()
    if (!['resolved', 'upheld', 'dismissed'].includes(outcome)) {
      throw new ValidationError('outcome must be resolved, upheld, or dismissed')
    }

    stream.disputeState.status = outcome
    stream.disputeState.resolution = resolution
    stream.disputeState.resolvedAt = nowIso()
    markStateDirty()
    res.json({ success: true, stream, disputeState: stream.disputeState })
  } catch (error) {
    next(error)
  }
})

// ── Expert Availability ───────────────────────────────────────────────────────

app.put('/api/profiles/:wallet/availability', authenticateToken, (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)
    if (wallet !== req.walletAddress) {
      throw new AuthorizationError('Can only update your own availability')
    }

    const record = profiles.get(wallet)
    if (!record) {
      throw new NotFoundError('Profile')
    }

    const VALID_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    const days = safeArray(req.body.days).map((d) => String(d).toLowerCase())
    for (const day of days) {
      if (!VALID_DAYS.includes(day)) {
        throw new ValidationError(`Invalid day: ${day}. Must be one of: ${VALID_DAYS.join(', ')}`)
      }
    }

    const hoursStart = Math.trunc(Number(req.body.hoursStart ?? 9))
    const hoursEnd = Math.trunc(Number(req.body.hoursEnd ?? 17))
    if (hoursStart < 0 || hoursStart > 23) {
      throw new ValidationError('hoursStart must be 0-23')
    }
    if (hoursEnd < 1 || hoursEnd > 24) {
      throw new ValidationError('hoursEnd must be 1-24')
    }
    if (hoursEnd <= hoursStart) {
      throw new ValidationError('hoursEnd must be after hoursStart')
    }

    record.profile.availability = {
      days,
      hoursStart,
      hoursEnd,
      timezone: record.profile.timezone || 'UTC',
      updatedAt: nowIso()
    }

    profiles.set(wallet, record)
    markStateDirty()
    res.json({ success: true, availability: record.profile.availability })
  } catch (error) {
    next(error)
  }
})

// ── Identity Linking ──────────────────────────────────────────────────────────

const VALID_IDENTITY_PLATFORMS = ['ens', 'github', 'twitter', 'linkedin', 'farcaster']

app.post('/api/identity/link', authenticateToken, (req, res, next) => {
  try {
    const platform = String(req.body.platform || '').toLowerCase()
    if (!VALID_IDENTITY_PLATFORMS.includes(platform)) {
      throw new ValidationError(`platform must be one of: ${VALID_IDENTITY_PLATFORMS.join(', ')}`)
    }

    const handle = String(req.body.handle || '').trim()
    if (!handle) {
      throw new ValidationError('handle is required')
    }
    if (handle.length > 100) {
      throw new ValidationError('handle must be 100 characters or fewer')
    }

    const duplicate = Array.from(identityLinks.values()).find(
      (l) => l.wallet === req.walletAddress && l.platform === platform
    )
    if (duplicate) {
      throw new ConflictError(`${platform} identity already linked`)
    }

    const link = {
      id: String(identityLinks.size + 1),
      wallet: req.walletAddress,
      platform,
      handle,
      createdAt: nowIso()
    }

    identityLinks.set(link.id, link)
    markStateDirty()
    res.json({ success: true, link })
  } catch (error) {
    next(error)
  }
})

app.get('/api/identity/:wallet', (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)
    const links = Array.from(identityLinks.values()).filter((l) => l.wallet === wallet)
    res.json({ success: true, wallet, links, count: links.length })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/identity/:id', authenticateToken, (req, res, next) => {
  try {
    const link = identityLinks.get(req.params.id)
    if (!link) {
      throw new NotFoundError('Identity link')
    }
    if (link.wallet !== req.walletAddress) {
      throw new AuthorizationError('Cannot remove another wallet\'s identity link')
    }
    identityLinks.delete(req.params.id)
    markStateDirty()
    res.json({ success: true, removed: req.params.id })
  } catch (error) {
    next(error)
  }
})

// ── Session Artifacts ─────────────────────────────────────────────────────────

const VALID_ARTIFACT_TYPES = ['note', 'summary', 'action_item', 'file_link', 'code_snippet']

app.post('/api/sessions/artifacts', authenticateToken, (req, res, next) => {
  try {
    const threadId = String(req.body.threadId || '').trim()
    if (!threadId) {
      throw new ValidationError('threadId is required')
    }

    const thread = conversationThreads.get(threadId)
    if (!thread) {
      throw new NotFoundError('Conversation thread')
    }
    if (!thread.participants.includes(req.walletAddress)) {
      throw new AuthorizationError('Cannot create artifact for this thread')
    }

    const type = String(req.body.type || '').toLowerCase()
    if (!VALID_ARTIFACT_TYPES.includes(type)) {
      throw new ValidationError(`type must be one of: ${VALID_ARTIFACT_TYPES.join(', ')}`)
    }

    const content = String(req.body.content || '').trim()
    if (!content) {
      throw new ValidationError('content is required')
    }
    if (content.length > 4000) {
      throw new ValidationError('content must be 4000 characters or fewer')
    }

    const artifact = {
      id: String(sessionArtifacts.size + 1),
      threadId,
      authorWallet: req.walletAddress,
      type,
      content,
      createdAt: nowIso()
    }

    sessionArtifacts.set(artifact.id, artifact)
    markStateDirty()
    res.json({ success: true, artifact })
  } catch (error) {
    next(error)
  }
})

app.get('/api/sessions/:threadId/artifacts', authenticateToken, (req, res, next) => {
  try {
    const thread = conversationThreads.get(req.params.threadId)
    if (!thread) {
      throw new NotFoundError('Conversation thread')
    }
    if (!thread.participants.includes(req.walletAddress)) {
      throw new AuthorizationError('Cannot view artifacts for this thread')
    }

    const artifacts = Array.from(sessionArtifacts.values())
      .filter((a) => a.threadId === req.params.threadId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

    res.json({ success: true, threadId: req.params.threadId, artifacts, count: artifacts.length })
  } catch (error) {
    next(error)
  }
})

app.get('/api/public/experts', authenticatePublicApi, (req, res) => {
  const expertiseFilter = String(req.query.expertise || '').toLowerCase()
  const experts = Array.from(profiles.values())
    .map((record) => record.profile)
    .filter((profile) => {
      if (!profile) return false
      if (!expertiseFilter) return true
      return safeArray(profile.expertise).map((item) => String(item).toLowerCase()).includes(expertiseFilter)
    })
    .map((profile) => ({
      wallet: profile.wallet,
      name: profile.name,
      hourlyRate: profile.hourlyRate,
      expertise: profile.expertise,
      completeness: profile.completeness
    }))

  res.json({ success: true, count: experts.length, experts })
})

app.get('/api/public/payments/streams/:streamId', authenticatePublicApi, (req, res, next) => {
  try {
    const stream = paymentStreams.get(req.params.streamId)
    if (!stream) {
      throw new NotFoundError('Stream')
    }

    res.json({
      success: true,
      stream: {
        id: stream.id,
        chainId: stream.chainId,
        amount: stream.amount,
        token: stream.token,
        status: stream.status,
        confirmationState: stream.confirmationState,
        submittedAt: stream.submittedAt,
        includedAt: stream.includedAt,
        reflectedAt: stream.reflectedAt
      }
    })
  } catch (error) {
    next(error)
  }
})

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method })
})

app.use(errorLogger)
app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error)
  }

  if (error instanceof AppError) {
    return res.status(error.statusCode).json(error.toJSON())
  }

  logger.error(`${req.method} ${req.url}`, error)
  res.status(500).json({
    error: config.isDev ? error.message : 'Internal server error'
  })
})

let server = null

export async function startServer() {
  const snapshot = await loadStateSnapshot(config.state.filePath)
  restoreState(snapshot)

  await initializeDatabase().catch((error) => {
    logger.error('Database initialization failed', error)
    throw error
  })

  if (!stateFlushTimer) {

    stateFlushTimer = setInterval(() => {
      flushStateSnapshot(false).catch((error) => {
        logger.error('State snapshot flush failed', error)
      })
    }, config.state.flushIntervalMs)
  }

  server = app.listen(config.server.port, config.server.host, () => {
    logger.info('PayTray backend skeleton started', {

      host: config.server.host,
      port: config.server.port,
      environment: config.env

    })
  })
}

process.on('SIGTERM', async () => {
  if (server) {
    server.close(async () => {
      if (stateFlushTimer) {
        clearInterval(stateFlushTimer)
        stateFlushTimer = null
      }
      await flushStateSnapshot(true).catch(() => {})
      await closeDatabase().catch(() => {})
      process.exit(0)
    })
  }
})

process.on('SIGINT', async () => {
  if (server) {
    server.close(async () => {
      if (stateFlushTimer) {
        clearInterval(stateFlushTimer)
        stateFlushTimer = null
      }
      await flushStateSnapshot(true).catch(() => {})
      await closeDatabase().catch(() => {})
      process.exit(0)
    })
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    logger.error('Startup failed', error)
    process.exit(1)
  })
}

export default app
