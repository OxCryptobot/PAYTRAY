import assert from 'node:assert/strict'
import request from 'supertest'
import { Wallet } from 'ethers'
import app from '../server.js'
import { closeDatabase, initializeDatabase } from '../lib/database.js'

const sender = new Wallet('0x59c6995e998f97a5a0044966f094538e4c7c9c5a1c1e8f2a4d4e0f3f1f3a7c5d')
const recipient = new Wallet('0x8b3a350cf5c34c9194ca3a545d79f8d8b8d3d1e8e8d0b6d2e6a0d3d4c2d1e9f3')
const tokenAddress = '0x1111111111111111111111111111111111111111'

async function login(wallet) {
  const challenge = await request(app)
    .post('/api/auth/challenge')
    .send({ wallet: wallet.address, chainId: 84532 })
  assert.equal(challenge.status, 200)

  const signature = await wallet.signMessage(challenge.body.challenge.message)
  const loginResponse = await request(app)
    .post('/api/auth/login')
    .send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.body.challenge.id,
      message: challenge.body.challenge.message,
      chainId: 84532
    })
  assert.equal(loginResponse.status, 200)
  return loginResponse.body.tokens.accessToken
}

try {
  await initializeDatabase()
  const token = await login(sender)
  const intentBody = {
    recipientWallet: recipient.address,
    chainId: 84532,
    tokenAddress,
    amountBaseUnits: '12500000',
    ratePerSecondBaseUnits: '3472',
    idempotencyKey: `phase1-v2-intent-${Date.now()}`
  }

  const first = await request(app)
    .post('/api/v2/payment-intents')
    .set('Authorization', `Bearer ${token}`)
    .send(intentBody)
  assert.equal(first.status, 201)
  assert.equal(first.body.idempotentReplay, false)
  assert.equal(first.body.source, 'durable_payment_intent')
  assert.equal(first.body.finalityStatus, 'unverified')

  const replay = await request(app)
    .post('/api/v2/payment-intents')
    .set('Authorization', `Bearer ${token}`)
    .send(intentBody)
  assert.equal(replay.status, 200)
  assert.equal(replay.body.idempotentReplay, true)
  assert.equal(replay.body.intent.id, first.body.intent.id)

  const retrieved = await request(app)
    .get(`/api/v2/payment-intents/${first.body.intent.id}`)
    .set('Authorization', `Bearer ${token}`)
  assert.equal(retrieved.status, 200)
  assert.equal(retrieved.body.intent.id, first.body.intent.id)

  const streams = await request(app)
    .get('/api/v2/streams')
    .set('Authorization', `Bearer ${token}`)
  assert.equal(streams.status, 200)
  assert.equal(streams.body.source, 'durable_payment_projection')

  console.log(JSON.stringify({
    status: 'ok',
    intentId: first.body.intent.id,
    replayStatus: replay.body.idempotentReplay,
    streamCount: streams.body.count
  }, null, 2))
} finally {
  await closeDatabase()
}
