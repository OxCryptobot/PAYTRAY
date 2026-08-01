import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import helmet from 'helmet'

import config, { validateConfig } from './lib/config.js'
import {
  AppError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  schemas,
  validate
} from './lib/errors.js'
import { getLogger, requestLogger, errorLogger } from './lib/logger.js'
import {
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

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
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
    next()
  } catch (error) {
    next(new AuthenticationError(error.message))
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'paytray-backend',
    version: '0.1.0',
    environment: config.env,
    timestamp: new Date().toISOString(),
    checks: {
      database: 'not-initialized',
      livekit: config.livekit.apiKey ? 'configured' : 'missing'
    }
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'paytray-backend',
    version: '0.1.0',
    environment: config.env,
    timestamp: new Date().toISOString()
  })
})

app.post('/api/auth/login', (req, res, next) => {
  try {
    const { wallet, signature, message = 'PayTray Login' } = req.body
    const validated = validate(
      {
        wallet: schemas.wallet.address,
        signature: schemas.wallet.signature
      },
      { wallet, signature }
    )

    const verification = verifyWalletSignature(message, validated.signature, validated.wallet)

    if (!verification.verified) {
      throw new AuthenticationError('Invalid signature')
    }

    const user = getOrCreateUser(validated.wallet)
    const tokens = generateTokenPair(user.id, user.wallet_address)

    res.json({
      success: true,
      user: {
        id: user.id,
        wallet: user.wallet_address,
        ensName: user.ens_name
      },
      tokens
    })
  } catch (error) {
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
      isExpert: true,
      updatedAt: new Date().toISOString(),
      completeness: calculateProfileCompleteness(validated)
    }

    const userRecord = getOrCreateUser(req.walletAddress)
    profiles.set(req.walletAddress, { user: userRecord, profile })

    res.json({ success: true, profile })
  } catch (error) {
    next(error)
  }
})

app.get('/api/profiles/:wallet', (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)
    const record = profiles.get(wallet)

    res.json({
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
      throw new AuthenticationError('Can only update your own profile')
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
      isExpert: true,
      updatedAt: new Date().toISOString(),
      completeness: calculateProfileCompleteness(validated)
    }

    profiles.set(wallet, { user: getOrCreateUser(wallet), profile })
    res.json({ success: true, profile })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/profiles/:wallet', authenticateToken, (req, res, next) => {
  try {
    const wallet = schemas.wallet.address(req.params.wallet)

    if (wallet !== req.walletAddress.toLowerCase()) {
      throw new AuthenticationError('Can only delete your own profile')
    }

    const record = profiles.get(wallet) || { user: getOrCreateUser(wallet), profile: null }
    profiles.set(wallet, { ...record, profile: null })
    res.json({ success: true })
  } catch (error) {
    next(error)
  }
})

app.get('/api/profiles/search', (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim().toLowerCase()

    if (!query) {
      throw new Error('Search query is required')
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

    res.json({ query, resultCount: results.length, results })
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

  res.json({ expertise, count: experts.length, experts })
})

app.get('/api/profiles/trending', (req, res) => {
  const limit = Number.parseInt(req.query.limit || '10', 10)

  const trending = Array.from(profiles.values())
    .filter((record) => Boolean(record.profile))
    .map((record) => record.profile)
    .sort((a, b) => (b.completeness || 0) - (a.completeness || 0))
    .slice(0, limit)

  res.json({ count: trending.length, profiles: trending })
})

app.post('/api/livekit/token', authenticateToken, (req, res, next) => {
  try {
    const validated = validate(
      {
        roomName: schemas.livekit.roomName,
        username: schemas.livekit.username
      },
      req.body
    )

    checkRateLimit(req.walletAddress || getClientIP(req), config.rateLimit.tokenGenLimit)

    const token = generateTokenPair(req.userId, req.walletAddress).accessToken

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
    const wallet = schemas.wallet.address(req.body.wallet)
    const chainId = Number.parseInt(req.body.chainId || '1', 10)

    if (![1, 10, 42161, 11155111].includes(chainId)) {
      throw new Error('Chain not supported')
    }

    res.json({ valid: true, wallet, chainId, verified: true })
  } catch (error) {
    next(error)
  }
})

app.post('/api/payments/streams', authenticateToken, (req, res, next) => {
  try {
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

    const streamId = String(paymentStreams.size + 1)
    const stream = {
      id: streamId,
      senderWallet: req.walletAddress,
      recipientWallet: validated.recipient,
      token: validated.token,
      amount: validated.amount,
      duration: validated.duration,
      start_time: nowSeconds(),
      stop_time: nowSeconds() + validated.duration,
      status: 'active',
      withdrawn: 0,
      createdAt: new Date().toISOString()
    }

    paymentStreams.set(streamId, stream)
    res.json({ success: true, stream })
  } catch (error) {
    next(error)
  }
})

app.get('/api/payments/streams', authenticateToken, (req, res) => {
  const streams = Array.from(paymentStreams.values()).filter((stream) => stream.senderWallet === req.walletAddress || stream.recipientWallet === req.walletAddress)
  res.json({ streams })
})

app.get('/api/payments/streams/:streamId', authenticateToken, (req, res, next) => {
  try {
    const stream = paymentStreams.get(req.params.streamId)

    if (!stream) {
      throw new NotFoundError('Stream')
    }

    res.json({ stream })
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

    const streamed = calculateStreamedAmount(stream)

    res.json({
      stats: {
        streamId: stream.id,
        total: stream.amount,
        streamed,
        available: Math.max(0, streamed - stream.withdrawn),
        withdrawn: stream.withdrawn,
        progress: stream.amount > 0 ? (streamed / stream.amount) * 100 : 0
      }
    })
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

    const amount = schemas.payment.amount(req.body.amount)
    const streamed = calculateStreamedAmount(stream)
    const available = Math.max(0, streamed - stream.withdrawn)

    if (amount > available) {
      throw new RateLimitError(`Insufficient available balance: ${available}`)
    }

    stream.withdrawn += amount
    paymentStreams.set(stream.id, stream)

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

    stream.status = 'cancelled'
    paymentStreams.set(stream.id, stream)

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
      createdAt: new Date().toISOString()
    }

    calls.set(call.id, call)
    res.json({ success: true, call })
  } catch (error) {
    next(error)
  }
})

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', path: req.path, method: req.method })
})

app.use(errorLogger)
app.use((error, req, res) => {
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
    server.close(() => process.exit(0))
  }
})

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    logger.error('Startup failed', error)
    process.exit(1)
  })
}

export default app
