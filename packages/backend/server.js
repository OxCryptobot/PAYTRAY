import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import helmet from 'helmet'
import crypto from 'crypto'

import config, { validateConfig } from './lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase } from './lib/database.js'
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  schemas,
  validate
} from './lib/errors.js'
import { getLogger, requestLogger, errorLogger } from './lib/logger.js'
import { loadStateSnapshot, saveStateSnapshot } from './lib/stateStore.js'
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
const profiles = new Map()
const paymentStreams = new Map()
const calls = new Map()
const matchSessions = new Map()
const conversationThreads = new Map()
const engagementContracts = new Map()
const reputationEvents = []
const rankingModel = {
  trainedAt: null,
  expertiseScores: {}
}
const chainRegistry = new Map([[String(config.payments.settlementChainId), { enabled: true, reason: 'default settlement chain' }]])
const queueJobs = new Map()
const extensionHooks = new Map()
const webhookDeliveries = new Map()
const authChallenges = new Map()
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
    'ops:*',
    'extensions:*'
  ]

  const isAdmin = config.auth.adminWallets.includes(walletAddress.toLowerCase())
  if (isAdmin) {
    return [...baseScopes, 'admin:*']
  }

  return baseScopes
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
    reputationEvents,
    rankingModel,
    chainRegistry: Array.from(chainRegistry.entries()),
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
  for (const value of safeArray(snapshot.reputationEvents)) reputationEvents.push(value)

  if (snapshot.rankingModel && typeof snapshot.rankingModel === 'object') {
    rankingModel.trainedAt = snapshot.rankingModel.trainedAt || null
    rankingModel.expertiseScores = snapshot.rankingModel.expertiseScores || {}
  }

  chainRegistry.clear()
  const restoredChains = safeArray(snapshot.chainRegistry)
  if (restoredChains.length) {
    for (const [key, value] of restoredChains) chainRegistry.set(key, value)
  } else {
    chainRegistry.set(String(config.payments.settlementChainId), { enabled: true, reason: 'default settlement chain' })
  }

  for (const [key, value] of safeArray(snapshot.queueJobs)) queueJobs.set(key, value)
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
      payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: config.webhooks.maxAttempts,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastError: null
    })
  }

  if (hooks.length > 0) {
    markStateDirty()
  }
}

async function processWebhookDeliveries({ dryRun = false } = {}) {
  const results = []

  for (const delivery of webhookDeliveries.values()) {
    if (!['pending', 'failed'].includes(delivery.status)) continue

    delivery.attempts += 1
    delivery.updatedAt = nowIso()
    delivery.status = 'processing'

    try {
      if (!dryRun) {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), config.webhooks.timeoutMs)

        try {
          const response = await fetch(delivery.callbackUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json'
            },
            body: JSON.stringify({ event: delivery.event, payload: delivery.payload }),
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
      results.push({ id: delivery.id, status: delivery.status })
    } catch (error) {
      delivery.lastError = error.message
      delivery.status = delivery.attempts >= delivery.maxAttempts ? 'dead' : 'failed'
      results.push({ id: delivery.id, status: delivery.status, error: delivery.lastError })
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

function validateOptionalUrl(value, fieldName) {
  if (value == null || value === '') {
    return null
  }

  if (typeof value !== 'string') {
    throw new ValidationError(`${fieldName} must be a valid URL`)
  }

  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ValidationError(`${fieldName} must use http or https`)
    }
    return parsed.toString()
  } catch {
    throw new ValidationError(`${fieldName} must be a valid URL`)
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
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

  rankingModel.trainedAt = nowIso()
  rankingModel.expertiseScores = expertiseScores

  return {
    trainedAt: rankingModel.trainedAt,
    sampleSize: reputationEvents.length,
    expertiseScores
  }
}

function scoreDiscoveryCandidate(profile, filters = {}) {
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
  const weighted = (skillMatch * 0.3) + (budgetScore * 0.15) + (timezoneScore * 0.1) + (languageScore * 0.1) + (chainScore * 0.1) + (completionRate * 0.15) + (outcomeHistoryBoost * 0.1)

  return Number((weighted * 100).toFixed(2))
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
    flags
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

try {
  validateConfig()
} catch (error) {
  logger.error('Configuration validation failed', error)
  throw error
}

app.use(helmet())
app.use(cors(config.cors))
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))
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
app.set('trust proxy', 1)

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
    const { wallet, signature, challengeId, message } = req.body
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
    const scopes = getDefaultScopes(user.wallet_address)
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
      chainPreference: req.body.chainPreference || config.payments.settlementChainId
    }

    const candidates = Array.from(profiles.values())
      .map((record) => record.profile)
      .filter((profile) => Boolean(profile) && profile.wallet !== req.walletAddress)
      .map((profile) => ({
        profile,
        score: scoreDiscoveryCandidate(profile, filters)
      }))
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
      candidates
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

    if (!message) {
      throw new ValidationError('Message is required')
    }

    if (message.length > 2000) {
      throw new ValidationError('Message must be 2000 characters or fewer')
    }

    if (!Number.isFinite(chainId)) {
      throw new ValidationError('Chain id must be an integer')
    }

    const supportedChainIds = new Set([1, 10, 42161, 11155111, config.payments.settlementChainId])
    if (!supportedChainIds.has(chainId)) {
      throw new ValidationError('Chain not supported')
    }

    const verification = verifyWalletSignature(message, validated.signature, validated.wallet)
    if (!verification.verified) {
      throw new AuthenticationError('Invalid signature')
    }

    res.json({
      valid: true,
      wallet: validated.wallet,
      chainId,
      verified: true,
      signer: verification.address,
      message: verification.message
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams', authenticateToken, (req, res, next) => {
  try {
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
    markStateDirty()
    res.json({ success: true, stream, uxState: stream.confirmationState, risk: riskCheck })
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
    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamAccess(stream, req.walletAddress, 'confirm')

    const state = String(req.body.state || '').toLowerCase()
    if (!['included', 'reflected'].includes(state)) {
      throw new ValidationError('State must be included or reflected')
    }

    if (state === 'included') {
      stream.confirmationState = 'included'
      stream.includedAt = nowIso()
    }

    if (state === 'reflected') {
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
    res.json({ success: true, streamId: stream.id, uxState: stream.confirmationState })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams/:streamId/withdraw', authenticateToken, (req, res, next) => {
  try {
    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    assertStreamAccess(stream, req.walletAddress, 'withdraw from')

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

app.post('/api/intelligence/ranking/train', authenticateToken, requireScopes('intelligence:*'), (req, res, next) => {
  try {
    const model = trainRankingModelFromOutcomes()
    res.json({ success: true, model })
  } catch (error) {
    next(error)
  }
})

app.get('/api/intelligence/ranking/model', authenticateToken, requireScopes('intelligence:*'), (req, res) => {
  res.json({ success: true, model: rankingModel })
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
      }
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

  for (const job of queueJobs.values()) {
    if (!['pending', 'failed'].includes(job.status)) continue

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
  res.json({ success: true, count: queueJobs.size, jobs: Array.from(queueJobs.values()) })
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

app.post('/api/extensions/hooks', authenticateToken, requireScopes('extensions:*'), (req, res, next) => {
  try {
    const event = String(req.body.event || '').trim()
    if (!event) {
      throw new ValidationError('Event is required')
    }

    const callbackUrl = validateOptionalUrl(req.body.callbackUrl, 'callbackUrl')
    if (!callbackUrl) {
      throw new ValidationError('callbackUrl is required')
    }

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
    const results = await processWebhookDeliveries({ dryRun })
    res.json({ success: true, dryRun, processed: results.length, results })
  } catch (error) {
    next(error)
  }
})

app.get('/api/ops/webhooks/deliveries', authenticateToken, requireScopes('ops:*'), (req, res) => {
  const deliveries = Array.from(webhookDeliveries.values())
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

  return server
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
