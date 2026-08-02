import { describe, it, expect } from 'vitest'
import request from 'supertest'
import { Wallet } from 'ethers'
import config from '../lib/config.js'
import { rateLimitMap } from '../lib/security.js'
import app from '../server.js'

async function createChallenge(walletAddress) {
  const response = await request(app).post('/api/auth/challenge').send({
    wallet: walletAddress
  })

  expect(response.status).toBe(200)
  expect(response.body.success).toBe(true)
  expect(response.body.challenge.id).toBeDefined()

  return response.body.challenge
}

async function loginWallet(wallet, options = {}) {
  const challenge = await createChallenge(wallet.address)
  const signature = await wallet.signMessage(challenge.message)
  const payload = {
    wallet: wallet.address,
    signature,
    challengeId: challenge.id,
    message: challenge.message
  }

  if (options.scopes) {
    payload.scopes = options.scopes
  }

  const response = await request(app).post('/api/auth/login').send(payload)

  expect(response.status).toBe(200)
  return response.body.tokens.accessToken
}

async function createWalletVerifyChallenge(walletAddress, chainId = 8453) {
  const response = await request(app).post('/api/wallet/verify/challenge').send({
    wallet: walletAddress,
    chainId
  })

  expect(response.status).toBe(200)
  expect(response.body.success).toBe(true)
  expect(response.body.challenge.id).toBeDefined()

  return response.body.challenge
}

describe('PayTray backend skeleton', () => {
  it('returns health status', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('healthy')
    expect(response.body.service).toBe('paytray-backend')
    expect(response.body.checks.database).toBe('unconfigured')
  })

  it('rejects invalid wallet signatures at login', async () => {
    const challengeResponse = await request(app).post('/api/auth/challenge').send({
      wallet: '0x742d35Cc6634C0532925a3b844Bc9e7595f42bE0'
    })

    expect(challengeResponse.status).toBe(200)

    const response = await request(app)
      .post('/api/auth/login')
      .send({
        wallet: '0x742d35Cc6634C0532925a3b844Bc9e7595f42bE0',
        signature: '0x1234',
        challengeId: challengeResponse.body.challenge.id,
        message: challengeResponse.body.challenge.message
      })

    expect(response.status).toBe(401)
  })

  it('rejects replayed auth challenges', async () => {
    const wallet = new Wallet('0xe30fcaee69dd76f6ca7b2852f31f24a3912666bcf9b178ddfd4896f4187fbe4c')
    const challenge = await createChallenge(wallet.address)
    const signature = await wallet.signMessage(challenge.message)

    const firstLogin = await request(app).post('/api/auth/login').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message
    })

    expect(firstLogin.status).toBe(200)

    const replayLogin = await request(app).post('/api/auth/login').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message
    })

    expect(replayLogin.status).toBe(401)
  })

  it('issues least-privilege access token when requested scopes are provided', async () => {
    const wallet = new Wallet('0xa6db1f969c30188939ee7f95da89a5fd1a5fd004b0a2bdba9f7bcf0ab6141f6f')
    const challenge = await createChallenge(wallet.address)
    const signature = await wallet.signMessage(challenge.message)

    const loginResponse = await request(app).post('/api/auth/login').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message,
      scopes: ['profile:*']
    })

    expect(loginResponse.status).toBe(200)
    expect(loginResponse.body.user.scopes).toEqual(['profile:*'])

    const opsResponse = await request(app)
      .get('/api/ops/slo')
      .set('Authorization', `Bearer ${loginResponse.body.tokens.accessToken}`)

    expect(opsResponse.status).toBe(403)
    expect(opsResponse.body.error).toContain('Missing required scopes')
  })

  it('rejects login scope escalation beyond wallet default scopes', async () => {
    const wallet = new Wallet('0x53d17d09c406910ae8d44b215268feca45de0f6e102e66595c22d14ee4ec504d')
    const challenge = await createChallenge(wallet.address)
    const signature = await wallet.signMessage(challenge.message)

    const loginResponse = await request(app).post('/api/auth/login').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message,
      scopes: ['admin:*']
    })

    expect(loginResponse.status).toBe(403)
    expect(loginResponse.body.error).toContain('Requested scope is not allowed')
  })

  it('rejects expired auth challenges', async () => {
    const wallet = new Wallet('0x82ef4188ca4d2dc6a9af4a8f97bb7c6d402ec9e0a5b98018fb33985a8de6bf98')
    const originalTTL = config.auth.challengeTTLSeconds

    try {
      config.auth.challengeTTLSeconds = -1
      const challenge = await createChallenge(wallet.address)
      const signature = await wallet.signMessage(challenge.message)

      const loginResponse = await request(app).post('/api/auth/login').send({
        wallet: wallet.address,
        signature,
        challengeId: challenge.id,
        message: challenge.message
      })

      expect(loginResponse.status).toBe(401)
    } finally {
      config.auth.challengeTTLSeconds = originalTTL
    }
  })

  it('rate limits repeated auth challenge requests', async () => {
    const wallet = new Wallet('0x2dc9535f9e16fd6ea2ce9e53e5d1ee097dbb6f709580fce39387c190f74b9131')
    const originalLimit = config.rateLimit.tokenGenLimit

    try {
      config.rateLimit.tokenGenLimit = 1
      rateLimitMap.clear()

      const firstResponse = await request(app).post('/api/auth/challenge').send({
        wallet: wallet.address
      })

      expect(firstResponse.status).toBe(200)

      const secondResponse = await request(app).post('/api/auth/challenge').send({
        wallet: wallet.address
      })

      expect(secondResponse.status).toBe(429)
    } finally {
      config.rateLimit.tokenGenLimit = originalLimit
      rateLimitMap.clear()
    }
  })

  it('rate limits repeated auth login attempts', async () => {
    const wallet = new Wallet('0x9b4db8b8341f8e7f730a31f9656e5f6cf0a8a0c75c2b9113ed0fbb47b4a8fca9')
    const originalLimit = config.auth.loginAttemptLimit

    try {
      config.auth.loginAttemptLimit = 1
      rateLimitMap.clear()

      const firstChallenge = await createChallenge(wallet.address)
      const firstSignature = await wallet.signMessage(firstChallenge.message)

      const firstLogin = await request(app).post('/api/auth/login').send({
        wallet: wallet.address,
        signature: firstSignature,
        challengeId: firstChallenge.id,
        message: firstChallenge.message
      })

      expect(firstLogin.status).toBe(200)

      const secondChallenge = await createChallenge(wallet.address)
      const secondSignature = await wallet.signMessage(secondChallenge.message)

      const secondLogin = await request(app).post('/api/auth/login').send({
        wallet: wallet.address,
        signature: secondSignature,
        challengeId: secondChallenge.id,
        message: secondChallenge.message
      })

      expect(secondLogin.status).toBe(429)
    } finally {
      config.auth.loginAttemptLimit = originalLimit
      rateLimitMap.clear()
    }
  })

  it('returns explicit degraded state when livekit token service is unconfigured', async () => {
    const wallet = new Wallet('0x4da4d0325dfef9ce2a53a8e5f4ed970f7c7e20c4d9afdbec8d244f2d5c491027')
    const token = await loginWallet(wallet)
    const originalApiKey = config.livekit.apiKey
    const originalApiSecret = config.livekit.apiSecret

    try {
      config.livekit.apiKey = null
      config.livekit.apiSecret = null

      const response = await request(app)
        .post('/api/livekit/token')
        .set('Authorization', `Bearer ${token}`)
        .send({ roomName: 'phaseb-room', username: 'planner' })

      expect(response.status).toBe(503)
      expect(response.body.error).toBe('LiveKit token service is not configured')
    } finally {
      config.livekit.apiKey = originalApiKey
      config.livekit.apiSecret = originalApiSecret
    }
  })

  it('issues livekit session token when service is configured', async () => {
    const wallet = new Wallet('0x49fba95fbeb2f9044f7bf3e823206fcaefda4e1747f60d182f57af7fce2fd0af')
    const authToken = await loginWallet(wallet)
    const originalApiKey = config.livekit.apiKey
    const originalApiSecret = config.livekit.apiSecret

    try {
      config.livekit.apiKey = 'dev-livekit-key'
      config.livekit.apiSecret = 'dev-livekit-secret'

      const response = await request(app)
        .post('/api/livekit/token')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ roomName: 'phaseb-room', username: 'planner' })

      expect(response.status).toBe(200)
      expect(typeof response.body.token).toBe('string')
      expect(response.body.token).not.toBe(authToken)
      expect(response.body.room).toBe('phaseb-room')
      expect(response.body.identity).toBe(wallet.address.toLowerCase())
    } finally {
      config.livekit.apiKey = originalApiKey
      config.livekit.apiSecret = originalApiSecret
    }
  })

  it('verifies wallet ownership with signed message on supported chain', async () => {
    const wallet = new Wallet('0x8ef6fdcff63f330083f31fc3a6fc76437c5fbf58cb8f2ecf332db7378158f42f')
    const challenge = await createWalletVerifyChallenge(wallet.address, 8453)
    const signature = await wallet.signMessage(challenge.message)

    const response = await request(app).post('/api/wallet/verify').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message,
      chainId: 8453
    })

    expect(response.status).toBe(200)
    expect(response.body.verified).toBe(true)
    expect(response.body.wallet).toBe(wallet.address.toLowerCase())
    expect(response.body.chainId).toBe(8453)
  })

  it('rejects wallet verification without challenge', async () => {
    const wallet = new Wallet('0xdd070a88d977f39f0572c0f4a77185159cb2f43ef4a64c0f906f32e56d335f7a')
    const message = 'PayTray wallet verification payload'
    const signature = await wallet.signMessage(message)

    const response = await request(app).post('/api/wallet/verify').send({
      wallet: wallet.address,
      signature,
      message,
      chainId: 8453
    })

    expect(response.status).toBe(401)
    expect(response.body.error).toBe('Wallet verification challenge is required')
  })

  it('rejects replayed wallet verification challenges', async () => {
    const wallet = new Wallet('0xd4de6f8f429ef8f8aeff31d3f56bece57d7eec1b6f38f80cddd5d5ce18f5d472')
    const challenge = await createWalletVerifyChallenge(wallet.address, 8453)
    const signature = await wallet.signMessage(challenge.message)

    const firstResponse = await request(app).post('/api/wallet/verify').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message,
      chainId: 8453
    })

    expect(firstResponse.status).toBe(200)

    const replayResponse = await request(app).post('/api/wallet/verify').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message,
      chainId: 8453
    })

    expect(replayResponse.status).toBe(401)
    expect(replayResponse.body.error).toBe('Wallet verification challenge is invalid or expired')
  })

  it('rejects wallet verification challenge on unsupported chain', async () => {
    const wallet = new Wallet('0x1be31a94361a391bbafb2a4ccd704f57dc04d4bb4d273ca1894300e6e8eb0311')
    const response = await request(app).post('/api/wallet/verify/challenge').send({
      wallet: wallet.address,
      chainId: 137
    })

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Chain not supported')
  })

  it('restricts payment stream access to participating wallets', async () => {
    const sender = new Wallet('0x59c6995e998f97a5a0044966f094538e4c7c9c5a1c1e8f2a4d4e0f3f1f3a7c5d')
    const recipient = new Wallet('0x8b3a350cf5c34c9194ca3a545d79f8d8b8d3d1e8e8d0b6d2e6a0d3d4c2d1e9f3')
    const outsider = new Wallet('0x5de4111afa1a4bca0b1d5f0b5b2f1b0d4c3a2e1f0f9e8d7c6b5a4a3a2b1c0d0e')
    const senderToken = await loginWallet(sender)
    const outsiderToken = await loginWallet(outsider)

    const createResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 12.5,
        duration: 3600
      })

    expect(createResponse.status).toBe(200)
    expect(createResponse.body.success).toBe(true)

    const streamId = createResponse.body.stream.id

    const forbiddenResponse = await request(app)
      .get(`/api/payments/streams/${streamId}/stats`)
      .set('Authorization', `Bearer ${outsiderToken}`)

    expect(forbiddenResponse.status).toBe(403)
  })

  it('returns explicit validation error when profile search query is missing', async () => {
    const response = await request(app).get('/api/profiles/search')

    expect(response.status).toBe(400)
    expect(response.body.error).toBe('Search query is required')
  })

  it('supports profile search route without being shadowed by wallet route', async () => {
    const expert = new Wallet('0x2f4b6ce95f2f1c9de2814e65f540fdf7c0f59a2f7649fd763987791dc3f4b8bc')
    const expertToken = await loginWallet(expert)

    const profileResponse = await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${expertToken}`)
      .send({
        name: 'Solidity Expert',
        bio: 'Audits and protocol design',
        hourlyRate: 200,
        expertise: ['solidity', 'defi']
      })

    expect(profileResponse.status).toBe(200)
    expect(profileResponse.body.success).toBe(true)
    expect(profileResponse.body.exists).toBe(true)

    const searchResponse = await request(app).get('/api/profiles/search?q=solidity')

    expect(searchResponse.status).toBe(200)
    expect(searchResponse.body.success).toBe(true)
    expect(searchResponse.body.count).toBeGreaterThanOrEqual(1)
  })

  it('returns 403 when updating another user profile', async () => {
    const owner = new Wallet('0x93b6f590f0a873a3f385431d0e81ad0fcf45a8fc1d74f3905ac9f7dd4ee3cd18')
    const attacker = new Wallet('0xaa9f6eeceb6d78d8f4fb7d88f7656db304fb0f6340f6df05f8dd09c7ed0eb6d2')
    const ownerToken = await loginWallet(owner)
    const attackerToken = await loginWallet(attacker)

    await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Owner Profile',
        bio: 'Primary profile',
        hourlyRate: 120,
        expertise: ['backend']
      })

    const response = await request(app)
      .post(`/api/profiles/${owner.address}`)
      .set('Authorization', `Bearer ${attackerToken}`)
      .send({
        name: 'Hijacked',
        bio: 'Should fail',
        hourlyRate: 1,
        expertise: ['none']
      })

    expect(response.status).toBe(403)
  })

  it('uses normalized payment stream list and stats contracts', async () => {
    const sender = new Wallet('0x4ea1bf0dc20e5b47a5e6df4027c9864f4586d2f8f3778a0b85afe7ea28982031')
    const recipient = new Wallet('0x60ac09be8d132f01f95d2e2d88ac4f410ea84d89d16df4f9ac58d5ecce967e91')
    const token = await loginWallet(sender)

    const createResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 5,
        duration: 1800
      })

    expect(createResponse.status).toBe(200)

    const listResponse = await request(app)
      .get('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)

    expect(listResponse.status).toBe(200)
    expect(listResponse.body.success).toBe(true)
    expect(listResponse.body.count).toBeGreaterThanOrEqual(1)

    const statsResponse = await request(app)
      .get(`/api/payments/streams/${createResponse.body.stream.id}/stats`)
      .set('Authorization', `Bearer ${token}`)

    expect(statsResponse.status).toBe(200)
    expect(statsResponse.body.success).toBe(true)
    expect(statsResponse.body.stats.streamId).toBe(createResponse.body.stream.id)
  })

  it('supports idempotent payment stream creation retries', async () => {
    const sender = new Wallet('0x7307fc132099f4fd31f7b2d2bc415dc2c4f8624ce00e4d4584342063774dc47a')
    const recipient = new Wallet('0x15aa21574f20ac8de79ba2f0db1e8c5a76852212dc47fbafca20c5dc7f28a4e9')
    const token = await loginWallet(sender)
    const idempotencyKey = 'stream-create-001'

    const firstResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 7,
        duration: 2400,
        chainId: 8453
      })

    expect(firstResponse.status).toBe(200)
    expect(firstResponse.body.idempotentReplay).toBe(false)

    const replayResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 7,
        duration: 2400,
        chainId: 8453
      })

    expect(replayResponse.status).toBe(200)
    expect(replayResponse.body.idempotentReplay).toBe(true)
    expect(replayResponse.body.stream.id).toBe(firstResponse.body.stream.id)
  })

  it('rejects idempotency key reuse with different stream payload', async () => {
    const sender = new Wallet('0xc0124e7d88472681a59c7d25f0d1e45d42bd5a6f1db11d308392f3eb7f97f0f6')
    const recipient = new Wallet('0x5f674d7257baa23cb2893620ef0cc14763f4eec7f3e8e3fd4d3f2d8b7f94c73e')
    const token = await loginWallet(sender)
    const idempotencyKey = 'stream-create-002'

    const firstResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 9,
        duration: 1800,
        chainId: 8453
      })

    expect(firstResponse.status).toBe(200)

    const conflictingResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .set('x-idempotency-key', idempotencyKey)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 10,
        duration: 1800,
        chainId: 8453
      })

    expect(conflictingResponse.status).toBe(409)
    expect(conflictingResponse.body.error).toBe('Idempotency key reuse with different payment request')
  })

  it('completes phase B coherence loop from discovery to reputation event', async () => {
    const expert = new Wallet('0x275d7ff5f5ddf7eb2bcda6acd67d65317e4bc6fa42a7f629e6c0f4f8c0f6f6b1')
    const requester = new Wallet('0x3482fdd64f835f5eab5f32ae72f574f9edac6d9bc7a04d728c3cac6519f6a9f2')
    const expertToken = await loginWallet(expert)
    const requesterToken = await loginWallet(requester)

    const profileResponse = await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${expertToken}`)
      .send({
        name: 'DeFi Planner',
        bio: 'Liquidity strategy and risk planning',
        hourlyRate: 150,
        expertise: ['defi', 'strategy'],
        timezone: 'UTC',
        languages: ['en'],
        chainPreference: 8453
      })

    expect(profileResponse.status).toBe(200)

    const discoveryResponse = await request(app)
      .post('/api/discovery/search')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({
        domain: 'defi',
        maxBudget: 200,
        timezone: 'UTC',
        language: 'en',
        chainPreference: 8453
      })

    expect(discoveryResponse.status).toBe(200)
    expect(discoveryResponse.body.success).toBe(true)
    expect(discoveryResponse.body.count).toBeGreaterThan(0)
    expect(discoveryResponse.body.candidates[0].scoreBreakdown).toBeDefined()
    expect(Array.isArray(discoveryResponse.body.candidates[0].scoreExplanation)).toBe(true)
    expect(discoveryResponse.body.rankingModel.version).toBeDefined()

    const selectResponse = await request(app)
      .post(`/api/matches/${discoveryResponse.body.matchSession.id}/select`)
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({
        expertWallet: expert.address,
        pricingMode: 'hourly',
        expectedDurationMinutes: 45
      })

    expect(selectResponse.status).toBe(200)
    expect(selectResponse.body.success).toBe(true)

    const handoffResponse = await request(app)
      .post(`/api/matches/${discoveryResponse.body.matchSession.id}/handoff`)
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({
        objective: 'ship integration architecture',
        budget: 300,
        suggestedAgenda: ['scope', 'milestones']
      })

    expect(handoffResponse.status).toBe(200)
    expect(handoffResponse.body.thread.id).toBeDefined()

    const messageResponse = await request(app)
      .post(`/api/threads/${handoffResponse.body.thread.id}/messages`)
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({ text: 'Need scope and budget alignment by deadline' })

    expect(messageResponse.status).toBe(200)

    const reputationResponse = await request(app)
      .post('/api/reputation/events')
      .set('Authorization', `Bearer ${requesterToken}`)
      .send({
        wallet: expert.address,
        sessionId: discoveryResponse.body.matchSession.id,
        outcome: 'completed',
        paidMinutes: 42,
        repeatBooking: true,
        expertise: ['defi']
      })

    expect(reputationResponse.status).toBe(200)
    expect(reputationResponse.body.summary.completed).toBeGreaterThan(0)
  })

  it('supports phase B single-chain payment state transitions', async () => {
    const sender = new Wallet('0x77610febafb4be98df30395b2bf2de932f3ef327ae5dddadf79f4d896092d712')
    const recipient = new Wallet('0xe22f9e80b8deec4f4cecc0f617f6c9723f35db3bc89f37f78b2dc53f21239087')
    const token = await loginWallet(sender)

    const createResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 8,
        duration: 1200,
        chainId: 8453
      })

    expect(createResponse.status).toBe(200)
    expect(createResponse.body.uxState).toBe('submitted')

    const includeResponse = await request(app)
      .post(`/api/payments/streams/${createResponse.body.stream.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'included' })

    expect(includeResponse.status).toBe(200)
    expect(includeResponse.body.uxState).toBe('included')

    const reflectResponse = await request(app)
      .post(`/api/payments/streams/${createResponse.body.stream.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'reflected' })

    expect(reflectResponse.status).toBe(200)
    expect(reflectResponse.body.uxState).toBe('reflected')
  })

  it('enforces strict payment confirmation state progression', async () => {
    const sender = new Wallet('0x7552d476f163f5a2b10a12f1e9f3ee2cd4d76eecf872b82ac0f9d6d6c04d87c1')
    const recipient = new Wallet('0xb686d59f8f8d4d812ad8e751adfa6acfd4b580b3ceec737beef98ec6df6b8fdf')
    const token = await loginWallet(sender)

    const createResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipientWallet: recipient.address,
        token: 'USDC',
        amount: 10,
        duration: 1800,
        chainId: 8453
      })

    expect(createResponse.status).toBe(200)

    const directReflectResponse = await request(app)
      .post(`/api/payments/streams/${createResponse.body.stream.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'reflected' })

    expect(directReflectResponse.status).toBe(409)
    expect(directReflectResponse.body.error).toContain('Cannot transition')

    const includeResponse = await request(app)
      .post(`/api/payments/streams/${createResponse.body.stream.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'included' })

    expect(includeResponse.status).toBe(200)

    const repeatedIncludeResponse = await request(app)
      .post(`/api/payments/streams/${createResponse.body.stream.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'included' })

    expect(repeatedIncludeResponse.status).toBe(409)

    const reflectResponse = await request(app)
      .post(`/api/payments/streams/${createResponse.body.stream.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'reflected' })

    expect(reflectResponse.status).toBe(200)

    const repeatedReflectResponse = await request(app)
      .post(`/api/payments/streams/${createResponse.body.stream.id}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state: 'reflected' })

    expect(repeatedReflectResponse.status).toBe(409)
    expect(repeatedReflectResponse.body.error).toBe('Stream is already reflected')
  })

  it('completes phase C intelligence endpoints', async () => {
    const user = new Wallet('0xc54584c06c5aa642ce0ed3afb4f5f1885edfad5393012615ad66cb7cc477a643')
    const expert = new Wallet('0x0e5f5f87687f84bd8226bb9a2a0cf5dd8cb97ee8ff06f08d3fee93f6f1290f7b')
    const token = await loginWallet(user)
    const expertToken = await loginWallet(expert)

    await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${expertToken}`)
      .send({
        name: 'Security Expert',
        bio: 'Audits and threat modeling',
        hourlyRate: 180,
        expertise: ['security'],
        timezone: 'UTC',
        languages: ['en']
      })

    const discoveryResponse = await request(app)
      .post('/api/discovery/search')
      .set('Authorization', `Bearer ${token}`)
      .send({ domain: 'security' })

    await request(app)
      .post(`/api/matches/${discoveryResponse.body.matchSession.id}/select`)
      .set('Authorization', `Bearer ${token}`)
      .send({ expertWallet: expert.address })

    const handoffResponse = await request(app)
      .post(`/api/matches/${discoveryResponse.body.matchSession.id}/handoff`)
      .set('Authorization', `Bearer ${token}`)
      .send({ objective: 'scope security review' })

    await request(app)
      .post(`/api/threads/${handoffResponse.body.thread.id}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'Need scope and deadline alignment with clear risk notes' })

    const assistResponse = await request(app)
      .post(`/api/intelligence/conversations/${handoffResponse.body.thread.id}/assist`)
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(assistResponse.status).toBe(200)
    expect(assistResponse.body.assistance.goals.length).toBeGreaterThan(0)

    const trainResponse = await request(app)
      .post('/api/intelligence/ranking/train')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(trainResponse.status).toBe(200)
    expect(trainResponse.body.model.version).toBeGreaterThan(0)
    expect(trainResponse.body.model.trainedAt).toBeDefined()
    expect(trainResponse.body.model.evaluation.sampleSize).toBeGreaterThan(0)

    const evaluateResponse = await request(app)
      .post('/api/intelligence/ranking/evaluate')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(evaluateResponse.status).toBe(200)
    expect(evaluateResponse.body.evaluation.metrics.completionPaidRate).toBeGreaterThanOrEqual(0)

    const modelResponse = await request(app)
      .get('/api/intelligence/ranking/model')
      .set('Authorization', `Bearer ${token}`)

    expect(modelResponse.status).toBe(200)
    expect(modelResponse.body.evaluation).toBeDefined()
    expect(modelResponse.body.model.weights).toBeDefined()

    const riskResponse = await request(app)
      .post('/api/intelligence/risk/payments/score')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipientWallet: expert.address,
        amount: 500,
        duration: 240,
        chainId: 8453
      })

    expect(riskResponse.status).toBe(200)
    expect(riskResponse.body.score.riskScore).toBeGreaterThanOrEqual(0)
    expect(Array.isArray(riskResponse.body.score.reasons)).toBe(true)
    expect(typeof riskResponse.body.score.recommendedAction).toBe('string')
  })

  it('completes phase D resilience and extension endpoints', async () => {
    const user = new Wallet('0x0478fe9f56db75c9797729ddf915f6ec4fca7ce866d4bc6228db653bd0dbfcec')
    const receiver = new Wallet('0x8c11f7f09a9529cff1327ebfef5fc8fa6d7f9e81f2055f2f5b64f6ddf53e72b0')
    const token = await loginWallet(user)

    const streamResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${token}`)
      .send({
        recipientWallet: receiver.address,
        token: 'USDC',
        amount: 6,
        duration: 900,
        chainId: 8453
      })

    expect(streamResponse.status).toBe(200)

    const reconciliationResponse = await request(app)
      .post('/api/ops/reconciliation/run')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(reconciliationResponse.status).toBe(200)
    expect(reconciliationResponse.body.success).toBe(true)

    const queueCreateResponse = await request(app)
      .post('/api/ops/queue/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'reconcile_stream', payload: { streamId: streamResponse.body.stream.id } })

    expect(queueCreateResponse.status).toBe(200)

    const queueProcessResponse = await request(app)
      .post('/api/ops/queue/process')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(queueProcessResponse.status).toBe(200)
    expect(queueProcessResponse.body.success).toBe(true)

    const chainEnableResponse = await request(app)
      .post('/api/ops/chains/enable')
      .set('Authorization', `Bearer ${token}`)
      .send({ chainId: 42161, reason: 'scale testing' })

    expect([200, 409]).toContain(chainEnableResponse.status)

    const sloResponse = await request(app)
      .get('/api/ops/slo')
      .set('Authorization', `Bearer ${token}`)

    expect(sloResponse.status).toBe(200)
    expect(sloResponse.body.slo).toBeDefined()

    const hookResponse = await request(app)
      .post('/api/extensions/hooks')
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'payment.reflected', callbackUrl: 'https://example.com/hook' })

    expect(hookResponse.status).toBe(200)

    const publicApiResponse = await request(app).get('/api/public/experts')
    expect([401, 503]).toContain(publicApiResponse.status)
  })

  it('rejects chain expansion when reliability sample size is below threshold', async () => {
    const operator = new Wallet('0xc5c45e7048ea387ee2eb7a9cef381fd27a7da3f3ebf4f11fbc87ba66dcf6b31f')
    const token = await loginWallet(operator)
    const originalMinSamples = config.payments.reliabilityMinSamples

    try {
      config.payments.reliabilityMinSamples = Number.MAX_SAFE_INTEGER

      const chainEnableResponse = await request(app)
        .post('/api/ops/chains/enable')
        .set('Authorization', `Bearer ${token}`)
        .send({ chainId: 42161, reason: 'sample-size gate test' })

      expect(chainEnableResponse.status).toBe(409)
      expect(chainEnableResponse.body.error).toContain('Insufficient reliability evidence')
    } finally {
      config.payments.reliabilityMinSamples = originalMinSamples
    }
  })

  it('includes scopes in login response and token-driven operations remain authorized', async () => {
    const wallet = new Wallet('0x92f4eb27a4324de90fa6a5cb6cbfa95f5f4d67e8f413f6077a2d5ef1b5d8a813')
    const challenge = await createChallenge(wallet.address)
    const signature = await wallet.signMessage(challenge.message)

    const loginResponse = await request(app).post('/api/auth/login').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message
    })

    expect(loginResponse.status).toBe(200)
    expect(Array.isArray(loginResponse.body.user.scopes)).toBe(true)
    expect(loginResponse.body.user.scopes).toContain('ops:*')

    const sloResponse = await request(app)
      .get('/api/ops/slo')
      .set('Authorization', `Bearer ${loginResponse.body.tokens.accessToken}`)

    expect(sloResponse.status).toBe(200)
    expect(sloResponse.body.success).toBe(true)
    expect(sloResponse.body.slo.auth).toBeDefined()
    expect(typeof sloResponse.body.slo.auth.challengesIssued).toBe('number')
    expect(typeof sloResponse.body.slo.auth.loginRateLimited).toBe('number')
    expect(sloResponse.body.slo.operations).toBeDefined()
    expect(typeof sloResponse.body.slo.operations.queue.total).toBe('number')
    expect(typeof sloResponse.body.slo.operations.webhooks.total).toBe('number')
    expect(typeof sloResponse.body.slo.operations.retryableQueueJobs).toBe('number')
    expect(typeof sloResponse.body.slo.operations.retryableWebhookDeliveries).toBe('number')
  })

  it('queues and processes webhook deliveries in dry-run mode', async () => {
    const owner = new Wallet('0x4f6918b69000f92df9f2b7a5d9163b91d8c1d74a0cd20dd6bf22ef90c6b2cc5f')
    const actor = new Wallet('0x909ffb91c379f5f9a22b366ec66785c00f4f56cc64df2f09cb5d9321cdb30daa')
    const ownerToken = await loginWallet(owner)
    const actorToken = await loginWallet(actor)
    const originalSigningSecret = config.webhooks.signingSecret

    try {
      config.webhooks.signingSecret = 'test-webhook-signing-secret'

      const hookResponse = await request(app)
        .post('/api/extensions/hooks')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ event: 'reputation.event.created', callbackUrl: 'https://example.com/hook' })

      expect(hookResponse.status).toBe(200)

      const eventResponse = await request(app)
        .post('/api/reputation/events')
        .set('Authorization', `Bearer ${actorToken}`)
        .send({
          wallet: owner.address,
          outcome: 'completed',
          paidMinutes: 30,
          expertise: ['backend']
        })

      expect(eventResponse.status).toBe(200)

      const deliveriesResponse = await request(app)
        .get('/api/ops/webhooks/deliveries')
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(deliveriesResponse.status).toBe(200)
      expect(deliveriesResponse.body.count).toBeGreaterThan(0)

      const processResponse = await request(app)
        .post('/api/ops/webhooks/process')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ dryRun: true })

      expect(processResponse.status).toBe(200)
      expect(processResponse.body.processed).toBeGreaterThan(0)

      const signedDeliveryResponse = await request(app)
        .get('/api/ops/webhooks/deliveries')
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(signedDeliveryResponse.status).toBe(200)
      const signedDelivery = signedDeliveryResponse.body.deliveries.find((delivery) => delivery.hookId === hookResponse.body.hook.id)
      expect(typeof signedDelivery.lastSignature).toBe('string')
      expect(signedDelivery.lastSignature.startsWith('v1=')).toBe(true)
      expect(typeof signedDelivery.lastSignatureTimestamp).toBe('string')
    } finally {
      config.webhooks.signingSecret = originalSigningSecret
    }
  })

  it('scopes webhook delivery visibility to hook owner', async () => {
    const owner = new Wallet('0xb7b9b97af72dcb1ff9d37a2b9712db4e8d42ce5ab9f8fb48f0d72f3c8dd7f5ad')
    const actor = new Wallet('0x58d30407ef8786fa130f820ec7d5a0f1a16c4fa83f7792fbeb6a8f9f9cc23544')
    const outsider = new Wallet('0xa74773cd26c07e98d53caecc5c659f3d70c25db513a7bcc8673de76979cb0a2c')
    const ownerToken = await loginWallet(owner)
    const actorToken = await loginWallet(actor)
    const outsiderToken = await loginWallet(outsider)

    const hookResponse = await request(app)
      .post('/api/extensions/hooks')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ event: 'reputation.event.created', callbackUrl: 'https://example.com/visibility-hook' })

    expect(hookResponse.status).toBe(200)

    const eventResponse = await request(app)
      .post('/api/reputation/events')
      .set('Authorization', `Bearer ${actorToken}`)
      .send({
        wallet: owner.address,
        outcome: 'completed',
        paidMinutes: 15,
        expertise: ['backend']
      })

    expect(eventResponse.status).toBe(200)

    const outsiderDeliveries = await request(app)
      .get('/api/ops/webhooks/deliveries')
      .set('Authorization', `Bearer ${outsiderToken}`)

    expect(outsiderDeliveries.status).toBe(200)
    const leakedDelivery = outsiderDeliveries.body.deliveries.find((delivery) => delivery.hookId === hookResponse.body.hook.id)
    expect(leakedDelivery).toBeUndefined()
  })

  it('scopes queue job visibility to owner wallet', async () => {
    const owner = new Wallet('0x9514e4f267db2d453cff018bc73bec3f4c7c764ab965f0b970f2b646e4534a46')
    const outsider = new Wallet('0xb4ca1c0f55ca94f22f4b6ce66ccded9a3e2b64c651f722f0c0a53568f5e8a6e9')
    const ownerToken = await loginWallet(owner)
    const outsiderToken = await loginWallet(outsider)

    const queueCreateResponse = await request(app)
      .post('/api/ops/queue/jobs')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'reconcile_stream', payload: { streamId: '1' } })

    expect(queueCreateResponse.status).toBe(200)

    const outsiderQueueResponse = await request(app)
      .get('/api/ops/queue/jobs')
      .set('Authorization', `Bearer ${outsiderToken}`)

    expect(outsiderQueueResponse.status).toBe(200)
    const leakedJob = outsiderQueueResponse.body.jobs.find((job) => job.id === queueCreateResponse.body.job.id)
    expect(leakedJob).toBeUndefined()
  })

  it('retries failed queue jobs through ops retry endpoint', async () => {
    const owner = new Wallet('0xf4cc0214d75a76a67c90fbf89f8f275561370f8033fb4a5e65e8f4be59cb0f84')
    const token = await loginWallet(owner)

    const queueCreateResponse = await request(app)
      .post('/api/ops/queue/jobs')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'reconcile_stream', payload: { streamId: 'missing-stream' }, maxAttempts: 1 })

    expect(queueCreateResponse.status).toBe(200)

    const processResponse = await request(app)
      .post('/api/ops/queue/process')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(processResponse.status).toBe(200)

    const retryResponse = await request(app)
      .post(`/api/ops/queue/jobs/${queueCreateResponse.body.job.id}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(retryResponse.status).toBe(200)
    expect(retryResponse.body.job.status).toBe('pending')
    expect(retryResponse.body.job.attempts).toBe(0)
  })

  it('retries failed webhook deliveries through ops retry endpoint', async () => {
    const owner = new Wallet('0x8ca89dc1aa20496e6bb84d355efd4f53a85fa6d75c3c77f882f9d3c2e7f4f9a1')
    const actor = new Wallet('0x851884dd6d5faf074a976f98b6cc3992e1367b9341ab9ceaa4beca2cc8d7704f')
    const ownerToken = await loginWallet(owner)
    const actorToken = await loginWallet(actor)
    const originalMaxAttempts = config.webhooks.maxAttempts

    try {
      config.webhooks.maxAttempts = 1

      const hookResponse = await request(app)
        .post('/api/extensions/hooks')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ event: 'reputation.event.created', callbackUrl: 'http://127.0.0.1:9/hook' })

      expect(hookResponse.status).toBe(200)

      const eventResponse = await request(app)
        .post('/api/reputation/events')
        .set('Authorization', `Bearer ${actorToken}`)
        .send({
          wallet: owner.address,
          outcome: 'completed',
          paidMinutes: 21,
          expertise: ['backend']
        })

      expect(eventResponse.status).toBe(200)

      const processResponse = await request(app)
        .post('/api/ops/webhooks/process')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ dryRun: false })

      expect(processResponse.status).toBe(200)
      expect(processResponse.body.processed).toBeGreaterThan(0)

      const deliveriesResponse = await request(app)
        .get('/api/ops/webhooks/deliveries')
        .set('Authorization', `Bearer ${ownerToken}`)

      expect(deliveriesResponse.status).toBe(200)
      const failedDelivery = deliveriesResponse.body.deliveries.find((delivery) => delivery.hookId === hookResponse.body.hook.id)
      expect(failedDelivery).toBeDefined()
      expect(['failed', 'dead']).toContain(failedDelivery.status)

      const retryResponse = await request(app)
        .post(`/api/ops/webhooks/deliveries/${failedDelivery.id}/retry`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({})

      expect(retryResponse.status).toBe(200)
      expect(retryResponse.body.delivery.status).toBe('pending')
      expect(retryResponse.body.delivery.attempts).toBe(0)
    } finally {
      config.webhooks.maxAttempts = originalMaxAttempts
    }
  })

  it('persists runtime state through ops endpoint', async () => {
    const user = new Wallet('0x2f517e876e2633ac2dcdf5f6a11a95a38d2dd59af09ee4b5f7fa4dbca6055ea8')
    const token = await loginWallet(user)

    const persistResponse = await request(app)
      .post('/api/ops/state/persist')
      .set('Authorization', `Bearer ${token}`)
      .send({})

    expect(persistResponse.status).toBe(200)
    expect(persistResponse.body.success).toBe(true)
    expect(typeof persistResponse.body.path).toBe('string')
  })

  it('creates and retrieves an engagement contract', async () => {
    const client = new Wallet('0x0101010101010101010101010101010101010101010101010101010101010101')
    const expert = new Wallet('0x0202020202020202020202020202020202020202020202020202020202020202')
    const clientToken = await loginWallet(client)

    const createResponse = await request(app)
      .post('/api/contracts')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        expertWallet: expert.address,
        scope: 'DeFi protocol audit and strategy advisory',
        pricingMode: 'hourly',
        rate: 200,
        currency: 'USDC',
        expectedDuration: 3600,
        cancellationPolicy: '24h_notice'
      })

    expect(createResponse.status).toBe(200)
    expect(createResponse.body.success).toBe(true)
    expect(createResponse.body.contract.status).toBe('active')
    expect(createResponse.body.contract.clientWallet).toBe(client.address.toLowerCase())
    expect(createResponse.body.contract.pricingMode).toBe('hourly')

    const contractId = createResponse.body.contract.id

    const expertToken = await loginWallet(expert)
    const getResponse = await request(app)
      .get(`/api/contracts/${contractId}`)
      .set('Authorization', `Bearer ${expertToken}`)

    expect(getResponse.status).toBe(200)
    expect(getResponse.body.contract.id).toBe(contractId)
  })

  it('closes an engagement contract with outcome and auto-creates reputation event', async () => {
    const client = new Wallet('0x0303030303030303030303030303030303030303030303030303030303030303')
    const expert = new Wallet('0x0404040404040404040404040404040404040404040404040404040404040404')
    const clientToken = await loginWallet(client)

    const createResponse = await request(app)
      .post('/api/contracts')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        expertWallet: expert.address,
        scope: 'Smart contract security review',
        pricingMode: 'fixed',
        rate: 5000,
        currency: 'USDC',
        expectedDuration: 7200
      })

    expect(createResponse.status).toBe(200)
    const contractId = createResponse.body.contract.id

    const closeResponse = await request(app)
      .post(`/api/contracts/${contractId}/close`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        outcome: 'completed',
        paidMinutes: 120,
        expertise: ['security', 'solidity']
      })

    expect(closeResponse.status).toBe(200)
    expect(closeResponse.body.contract.status).toBe('closed')
    expect(closeResponse.body.contract.outcome).toBe('completed')
    expect(closeResponse.body.reputationEvent).toBeDefined()
    expect(closeResponse.body.reputationEvent.outcome).toBe('completed')
    expect(closeResponse.body.reputationEvent.contractId).toBe(contractId)
  })

  it('disputes an active engagement contract', async () => {
    const client = new Wallet('0x0505050505050505050505050505050505050505050505050505050505050505')
    const expert = new Wallet('0x0606060606060606060606060606060606060606060606060606060606060606')
    const clientToken = await loginWallet(client)

    const createResponse = await request(app)
      .post('/api/contracts')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        expertWallet: expert.address,
        scope: 'Tokenomics design',
        pricingMode: 'hourly',
        rate: 300,
        currency: 'USDC'
      })

    expect(createResponse.status).toBe(200)
    const contractId = createResponse.body.contract.id

    const disputeResponse = await request(app)
      .post(`/api/contracts/${contractId}/dispute`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ reason: 'Deliverables not met as agreed in scope' })

    expect(disputeResponse.status).toBe(200)
    expect(disputeResponse.body.contract.status).toBe('disputed')
    expect(disputeResponse.body.contract.disputeReason).toBeTruthy()

    const doubleDisputeResponse = await request(app)
      .post(`/api/contracts/${contractId}/dispute`)
      .set('Authorization', `Bearer ${clientToken}`)
      .send({ reason: 'Again' })

    expect(doubleDisputeResponse.status).toBe(409)
  })

  it('restricts contract visibility to participating wallets', async () => {
    const client = new Wallet('0x0707070707070707070707070707070707070707070707070707070707070707')
    const expert = new Wallet('0x0808080808080808080808080808080808080808080808080808080808080808')
    const outsider = new Wallet('0x0909090909090909090909090909090909090909090909090909090909090909')
    const clientToken = await loginWallet(client)
    const outsiderToken = await loginWallet(outsider)

    const createResponse = await request(app)
      .post('/api/contracts')
      .set('Authorization', `Bearer ${clientToken}`)
      .send({
        expertWallet: expert.address,
        scope: 'Private advisory',
        pricingMode: 'fixed',
        rate: 1000,
        currency: 'USDC'
      })

    expect(createResponse.status).toBe(200)
    const contractId = createResponse.body.contract.id

    const forbiddenResponse = await request(app)
      .get(`/api/contracts/${contractId}`)
      .set('Authorization', `Bearer ${outsiderToken}`)

    expect(forbiddenResponse.status).toBe(403)
  })

  it('admin creates and resolves a trust signal', async () => {
    const adminWallet = new Wallet('0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a')
    const targetWallet = new Wallet('0x0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b')
    const originalAdminWallets = config.auth.adminWallets

    try {
      config.auth.adminWallets = [adminWallet.address.toLowerCase()]
      const adminToken = await loginWallet(adminWallet)

      const flagResponse = await request(app)
        .post('/api/trust/signals')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          wallet: targetWallet.address,
          type: 'fraud_flag',
          severity: 'high',
          reason: 'Suspected wallet address spoofing in payment requests'
        })

      expect(flagResponse.status).toBe(200)
      expect(flagResponse.body.success).toBe(true)
      expect(flagResponse.body.signal.status).toBe('open')
      expect(flagResponse.body.signal.severity).toBe('high')

      const signalId = flagResponse.body.signal.id

      const resolveResponse = await request(app)
        .post(`/api/trust/signals/${signalId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ resolution: 'Reviewed and confirmed false positive after wallet verification' })

      expect(resolveResponse.status).toBe(200)
      expect(resolveResponse.body.signal.status).toBe('resolved')
      expect(resolveResponse.body.signal.resolvedAt).toBeTruthy()
    } finally {
      config.auth.adminWallets = originalAdminWallets
    }
  })

  it('rejects trust signal creation from non-admin wallet', async () => {
    const regularWallet = new Wallet('0x0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c')
    const targetWallet = new Wallet('0x0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d')
    const regularToken = await loginWallet(regularWallet)

    const response = await request(app)
      .post('/api/trust/signals')
      .set('Authorization', `Bearer ${regularToken}`)
      .send({
        wallet: targetWallet.address,
        type: 'manual_review',
        severity: 'low',
        reason: 'Suspicious activity'
      })

    expect(response.status).toBe(403)
  })

  it('synthesizes a conversation thread into a structured summary', async () => {
    const walletA = new Wallet('0x0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e')
    const walletB = new Wallet('0x0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f')
    const tokenA = await loginWallet(walletA)
    const tokenB = await loginWallet(walletB)

    await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Synthesis Expert', bio: 'DeFi', hourlyRate: 100, expertise: ['defi'], timezone: 'UTC', languages: ['en'] })

    const matchResponse = await request(app)
      .post('/api/discovery/search')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ query: 'DeFi help', filters: { domain: 'defi' } })

    expect(matchResponse.status).toBe(200)
    const sessionId = matchResponse.body.matchSession.id

    await request(app)
      .post(`/api/matches/${sessionId}/select`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expertWallet: walletB.address })

    const handoffResponse = await request(app)
      .post(`/api/matches/${sessionId}/handoff`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expertWallet: walletB.address })

    expect(handoffResponse.status).toBe(200)
    const threadId = handoffResponse.body.thread.id

    await request(app)
      .post(`/api/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ text: 'I need help with liquidity strategy and DeFi protocol review. Action: send proposal by Friday.' })

    await request(app)
      .post(`/api/threads/${threadId}/messages`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ text: 'I will review the protocol and follow up with recommendations. Todo: complete audit next week.' })

    const synthResponse = await request(app)
      .post(`/api/intelligence/conversations/${threadId}/synthesize`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(synthResponse.status).toBe(200)
    expect(synthResponse.body.success).toBe(true)
    expect(synthResponse.body.synthesis.threadId).toBe(threadId)
    expect(synthResponse.body.synthesis.messageCount).toBe(2)
    expect(Array.isArray(synthResponse.body.synthesis.keyTopics)).toBe(true)
    expect(Array.isArray(synthResponse.body.synthesis.actionItems)).toBe(true)
    expect(synthResponse.body.synthesis.actionItems.length).toBeGreaterThan(0)
    expect(synthResponse.body.synthesis.suggestedFollowUp).toBeTruthy()
  })

  it('reputation events incrementally update ranking evaluation metrics', async () => {
    const actor = new Wallet('0x1010101010101010101010101010101010101010101010101010101010101010')
    const subject = new Wallet('0x1111111111111111111111111111111111111111111111111111111111111111')
    const actorToken = await loginWallet(actor)

    const beforeResponse = await request(app)
      .get('/api/intelligence/ranking/model')
      .set('Authorization', `Bearer ${actorToken}`)

    expect(beforeResponse.status).toBe(200)
    const beforeSize = beforeResponse.body.evaluation.sampleSize

    await request(app)
      .post('/api/reputation/events')
      .set('Authorization', `Bearer ${actorToken}`)
      .send({
        wallet: subject.address,
        outcome: 'completed',
        paidMinutes: 90,
        repeatBooking: true,
        expertise: ['solidity', 'audit']
      })

    const afterResponse = await request(app)
      .get('/api/intelligence/ranking/model')
      .set('Authorization', `Bearer ${actorToken}`)

    expect(afterResponse.status).toBe(200)
    expect(afterResponse.body.evaluation.sampleSize).toBe(beforeSize + 1)
    expect(afterResponse.body.evaluation.metrics.avgPaidMinutes).toBeGreaterThan(0)
  })

  it('reconciles reflected payment streams to the off-chain ledger', async () => {
    const sender = new Wallet('0x1212121212121212121212121212121212121212121212121212121212121212')
    const recipient = new Wallet('0x1313131313131313131313131313131313131313131313131313131313131313')
    const senderToken = await loginWallet(sender)
    const recipientToken = await loginWallet(recipient)

    const streamResponse = await request(app)
      .post('/api/payments/streams')
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ recipientWallet: recipient.address, token: 'USDC', amount: 50, duration: 3600, chainId: 8453 })

    expect(streamResponse.status).toBe(200)
    const streamId = streamResponse.body.stream.id

    await request(app)
      .post(`/api/payments/streams/${streamId}/confirm`)
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ state: 'included', txHash: '0xabc', blockNumber: 100 })

    await request(app)
      .post(`/api/payments/streams/${streamId}/confirm`)
      .set('Authorization', `Bearer ${senderToken}`)
      .send({ state: 'reflected', txHash: '0xabc', blockNumber: 100 })

    const reconcileResponse = await request(app)
      .post('/api/ops/ledger/reconcile')
      .set('Authorization', `Bearer ${senderToken}`)

    expect(reconcileResponse.status).toBe(200)
    expect(reconcileResponse.body.reconciled).toBeGreaterThanOrEqual(1)

    const ledgerResponse = await request(app)
      .get(`/api/ledger/${recipient.address}`)
      .set('Authorization', `Bearer ${recipientToken}`)

    expect(ledgerResponse.status).toBe(200)
    expect(ledgerResponse.body.entries.length).toBeGreaterThan(0)
    expect(ledgerResponse.body.entries[0].settledBalance).toBeGreaterThan(0)
  })

  it('rejects viewing another wallet ledger without admin scope', async () => {
    const walletA = new Wallet('0x1414141414141414141414141414141414141414141414141414141414141414')
    const walletB = new Wallet('0x1515151515151515151515151515151515151515151515151515151515151515')
    const tokenA = await loginWallet(walletA)

    const response = await request(app)
      .get(`/api/ledger/${walletB.address}`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(response.status).toBe(403)
  })

  it('opens a payment dispute and resolves it as admin', async () => {
    const disputeSender = new Wallet('0x1616161616161616161616161616161616161616161616161616161616161616')
    const disputeRecipient = new Wallet('0x1717171717171717171717171717171717171717171717171717171717171717')
    const adminWallet = new Wallet('0x1818181818181818181818181818181818181818181818181818181818181818')
    const senderToken = await loginWallet(disputeSender)
    const originalAdminWallets = config.auth.adminWallets

    try {
      config.auth.adminWallets = [adminWallet.address.toLowerCase()]
      const adminToken = await loginWallet(adminWallet)

      const streamResponse = await request(app)
        .post('/api/payments/streams')
        .set('Authorization', `Bearer ${senderToken}`)
        .send({ recipientWallet: disputeRecipient.address, token: 'USDC', amount: 25, duration: 1800, chainId: 8453 })

      expect(streamResponse.status).toBe(200)
      const streamId = streamResponse.body.stream.id

      const disputeResponse = await request(app)
        .post(`/api/payments/streams/${streamId}/dispute`)
        .set('Authorization', `Bearer ${senderToken}`)
        .send({ reason: 'Recipient wallet address does not match agreed counterparty' })

      expect(disputeResponse.status).toBe(200)
      expect(disputeResponse.body.disputeState.status).toBe('open')
      expect(disputeResponse.body.disputeState.raisedBy).toBe(disputeSender.address.toLowerCase())

      const duplicateResponse = await request(app)
        .post(`/api/payments/streams/${streamId}/dispute`)
        .set('Authorization', `Bearer ${senderToken}`)
        .send({ reason: 'Again' })

      expect(duplicateResponse.status).toBe(409)

      const resolveResponse = await request(app)
        .post(`/api/payments/streams/${streamId}/dispute/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ resolution: 'Reviewed transaction evidence; dispute dismissed', outcome: 'dismissed' })

      expect(resolveResponse.status).toBe(200)
      expect(resolveResponse.body.disputeState.status).toBe('dismissed')
      expect(resolveResponse.body.disputeState.resolvedAt).toBeTruthy()
    } finally {
      config.auth.adminWallets = originalAdminWallets
    }
  })

  it('sets expert availability and filters discovery by available day', async () => {
    const expert = new Wallet('0x1919191919191919191919191919191919191919191919191919191919191919')
    const searcher = new Wallet('0x2020202020202020202020202020202020202020202020202020202020202020')
    const expertToken = await loginWallet(expert)
    const searcherToken = await loginWallet(searcher)

    await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${expertToken}`)
      .send({ name: 'Available Expert', bio: 'NFT strategy', hourlyRate: 80, expertise: ['nft'], timezone: 'UTC', languages: ['en'] })

    const availResponse = await request(app)
      .put(`/api/profiles/${expert.address}/availability`)
      .set('Authorization', `Bearer ${expertToken}`)
      .send({ days: ['mon', 'wed', 'fri'], hoursStart: 9, hoursEnd: 17 })

    expect(availResponse.status).toBe(200)
    expect(availResponse.body.availability.days).toContain('mon')

    const matchResponse = await request(app)
      .post('/api/discovery/search')
      .set('Authorization', `Bearer ${searcherToken}`)
      .send({ query: 'NFT help', filters: { domain: 'nft' }, availableDay: 'mon' })

    expect(matchResponse.status).toBe(200)
    const found = matchResponse.body.candidates.some((c) => c.profile.wallet === expert.address.toLowerCase())
    expect(found).toBe(true)

    const noMatchResponse = await request(app)
      .post('/api/discovery/search')
      .set('Authorization', `Bearer ${searcherToken}`)
      .send({ query: 'NFT help', filters: { domain: 'nft' }, availableDay: 'sat' })

    expect(noMatchResponse.status).toBe(200)
    const notFound = noMatchResponse.body.candidates.every((c) => c.profile.wallet !== expert.address.toLowerCase())
    expect(notFound).toBe(true)
  })

  it('links and retrieves social identity for a wallet', async () => {
    const wallet = new Wallet('0x2121212121212121212121212121212121212121212121212121212121212121')
    const token = await loginWallet(wallet)

    const linkResponse = await request(app)
      .post('/api/identity/link')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'github', handle: 'peerstream-dev' })

    expect(linkResponse.status).toBe(200)
    expect(linkResponse.body.link.platform).toBe('github')
    expect(linkResponse.body.link.handle).toBe('peerstream-dev')

    const duplicateResponse = await request(app)
      .post('/api/identity/link')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'github', handle: 'other-handle' })

    expect(duplicateResponse.status).toBe(409)

    const getResponse = await request(app)
      .get(`/api/identity/${wallet.address}`)

    expect(getResponse.status).toBe(200)
    expect(getResponse.body.links.length).toBeGreaterThanOrEqual(1)
    expect(getResponse.body.links[0].platform).toBe('github')
  })

  it('removes an identity link', async () => {
    const wallet = new Wallet('0x2222222222222222222222222222222222222222222222222222222222222222')
    const token = await loginWallet(wallet)

    const linkResponse = await request(app)
      .post('/api/identity/link')
      .set('Authorization', `Bearer ${token}`)
      .send({ platform: 'twitter', handle: '@peerstream' })

    expect(linkResponse.status).toBe(200)
    const linkId = linkResponse.body.link.id

    const deleteResponse = await request(app)
      .delete(`/api/identity/${linkId}`)
      .set('Authorization', `Bearer ${token}`)

    expect(deleteResponse.status).toBe(200)
    expect(deleteResponse.body.removed).toBe(linkId)

    const getResponse = await request(app)
      .get(`/api/identity/${wallet.address}`)

    expect(getResponse.status).toBe(200)
    const stillPresent = getResponse.body.links.some((l) => l.id === linkId)
    expect(stillPresent).toBe(false)
  })

  it('saves and retrieves session artifacts for a thread', async () => {
    const participantA = new Wallet('0x2323232323232323232323232323232323232323232323232323232323232323')
    const participantB = new Wallet('0x2424242424242424242424242424242424242424242424242424242424242424')
    const outsider = new Wallet('0x2525252525252525252525252525252525252525252525252525252525252525')
    const tokenA = await loginWallet(participantA)
    const tokenB = await loginWallet(participantB)
    const outsiderToken = await loginWallet(outsider)

    await request(app)
      .post('/api/profiles')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Artifact Expert', bio: 'Web3 consulting', hourlyRate: 120, expertise: ['web3'], timezone: 'UTC', languages: ['en'] })

    const searchResponse = await request(app)
      .post('/api/discovery/search')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ query: 'Web3 consulting', filters: { domain: 'web3' } })

    expect(searchResponse.status).toBe(200)
    const sessionId = searchResponse.body.matchSession.id

    await request(app)
      .post(`/api/matches/${sessionId}/select`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expertWallet: participantB.address })

    const handoffResponse = await request(app)
      .post(`/api/matches/${sessionId}/handoff`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ expertWallet: participantB.address })

    expect(handoffResponse.status).toBe(200)
    const threadId = handoffResponse.body.thread.id

    const artifactResponse = await request(app)
      .post('/api/sessions/artifacts')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ threadId, type: 'action_item', content: 'Review token allocation proposal by end of week' })

    expect(artifactResponse.status).toBe(200)
    expect(artifactResponse.body.artifact.type).toBe('action_item')
    expect(artifactResponse.body.artifact.threadId).toBe(threadId)

    const noteResponse = await request(app)
      .post('/api/sessions/artifacts')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ threadId, type: 'note', content: 'Client prefers Base chain for lower gas fees' })

    expect(noteResponse.status).toBe(200)

    const listResponse = await request(app)
      .get(`/api/sessions/${threadId}/artifacts`)
      .set('Authorization', `Bearer ${tokenA}`)

    expect(listResponse.status).toBe(200)
    expect(listResponse.body.count).toBe(2)
    expect(listResponse.body.artifacts[0].type).toBe('action_item')

    const forbiddenResponse = await request(app)
      .get(`/api/sessions/${threadId}/artifacts`)
      .set('Authorization', `Bearer ${outsiderToken}`)

    expect(forbiddenResponse.status).toBe(403)
  })
})
