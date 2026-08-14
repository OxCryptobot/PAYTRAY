import assert from 'node:assert/strict'
import request from 'supertest'
import { Wallet } from 'ethers'
import app from '../server.js'
import config from '../lib/config.js'
import { closeDatabase, initializeDatabase, transaction } from '../lib/database.js'

const operator = new Wallet('0xc5c45e7048ea387ee2eb7a9cef381fd27a7da3f3ebf4f11fbc87ba66dcf6b31f')
config.auth.operatorWallets.push(operator.address.toLowerCase())

async function login(wallet) {
  const challenge = await request(app).post('/api/auth/challenge').send({ wallet: wallet.address, chainId: 84532 })
  assert.equal(challenge.status, 200)
  const signature = await wallet.signMessage(challenge.body.challenge.message)
  const response = await request(app).post('/api/auth/login').send({
    wallet: wallet.address,
    signature,
    challengeId: challenge.body.challenge.id,
    message: challenge.body.challenge.message,
    chainId: 84532
  })
  assert.equal(response.status, 200)
  return response.body.tokens.accessToken
}

try {
  await initializeDatabase()
  const outcome = await transaction(async (client) => {
    const result = await client.query(`
      SELECT id
      FROM engagement_outcome_events
      WHERE verification_status = 'unverified'
      ORDER BY created_at DESC
      LIMIT 1
    `)
    return result.rows[0] || null
  })
  assert.ok(outcome, 'Expected an unverified CI outcome before verifier pilot')
  const token = await login(operator)
  const evidence = {
    source: 'ci-verifier-pilot',
    finalityStatus: 'finalized',
    authoritativeEvidenceId: `ci-outcome-${outcome.id}`
  }
  const first = await request(app)
    .post(`/api/v2/outcomes/${outcome.id}/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({ verificationStatus: 'verified', verificationEvidence: evidence })
  assert.equal(first.status, 200)
  assert.equal(first.body.outcome.verification_status, 'verified')
  assert.equal(first.body.idempotentReplay, false)

  const replay = await request(app)
    .post(`/api/v2/outcomes/${outcome.id}/verify`)
    .set('Authorization', `Bearer ${token}`)
    .send({ verificationStatus: 'verified', verificationEvidence: evidence })
  assert.equal(replay.status, 200)
  assert.equal(replay.body.idempotentReplay, true)

  console.log(JSON.stringify({ status: 'ok', outcomeId: outcome.id, firstReplay: first.body.idempotentReplay, replayReplay: replay.body.idempotentReplay }, null, 2))
} finally {
  await closeDatabase()
}
