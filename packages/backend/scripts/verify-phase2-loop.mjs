import assert from 'node:assert/strict'
import request from 'supertest'
import { Wallet } from 'ethers'
import app from '../server.js'
import config from '../lib/config.js'
import { closeDatabase, initializeDatabase, transaction } from '../lib/database.js'
import { parseTokenRegistry } from '../lib/payments/tokenRegistry.js'

const client = Wallet.createRandom()
const provider = Wallet.createRandom()
const operator = Wallet.createRandom()
let tokenAddress = null

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

async function cleanupSmokeData() {
  const wallets = [client.address.toLowerCase(), provider.address.toLowerCase(), operator.address.toLowerCase()]
  await transaction(async (db) => {
    const users = await db.query('SELECT id FROM users WHERE wallet_address = ANY($1::varchar[])', [wallets])
    const userIds = users.rows.map((row) => row.id)
    if (userIds.length === 0) return
    await db.query(`DELETE FROM ledger_entries
      WHERE source_chain_event_id IN (SELECT id FROM payment_chain_events WHERE intent_id IN (SELECT id FROM payment_intents WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])))
         OR source_intent_id IN (SELECT id FROM payment_intents WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[]))`, [userIds])
    await db.query('DELETE FROM payment_chain_events WHERE intent_id IN (SELECT id FROM payment_intents WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[]))', [userIds])
    await db.query('DELETE FROM payment_streams WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])', [userIds])
    await db.query('DELETE FROM payment_intents WHERE sender_id = ANY($1::uuid[]) OR recipient_id = ANY($1::uuid[])', [userIds])
    await db.query('DELETE FROM engagement_outcome_events WHERE engagement_id IN (SELECT id FROM engagements WHERE client_id = ANY($1::uuid[]) OR provider_id = ANY($1::uuid[]))', [userIds])
    await db.query('DELETE FROM discovery_impressions WHERE client_id = ANY($1::uuid[]) OR candidate_profile_id IN (SELECT id FROM profiles WHERE user_id = ANY($1::uuid[]))', [userIds])
    await db.query('DELETE FROM engagements WHERE client_id = ANY($1::uuid[]) OR provider_id = ANY($1::uuid[])', [userIds])
    await db.query('DELETE FROM profiles WHERE user_id = ANY($1::uuid[])', [userIds])
    await db.query('DELETE FROM wallet_connections WHERE user_id = ANY($1::uuid[])', [userIds])
    await db.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds])
  })
}

async function ensureProfile() {
  await transaction(async (db) => {
    const users = {}
    for (const [key, wallet] of [['client', client], ['provider', provider]]) {
      const existing = await db.query('SELECT id FROM users WHERE wallet_address = $1', [wallet.address.toLowerCase()])
      if (existing.rows[0]) users[key] = existing.rows[0].id
      else {
        const created = await db.query(
          `INSERT INTO users (wallet_address, wallet_type, last_login)
           VALUES ($1, 'injected', CURRENT_TIMESTAMP) RETURNING id`,
          [wallet.address.toLowerCase()]
        )
        users[key] = created.rows[0].id
      }
    }
    const profile = await db.query('SELECT id FROM profiles WHERE user_id = $1 LIMIT 1', [users.provider])
    if (!profile.rows[0]) {
      await db.query(
        `INSERT INTO profiles (
          user_id, name, bio, hourly_rate, expertise, is_expert, completeness,
          availability_status, timezone, languages, verification_status,
          response_latency_seconds, completion_rate, repeat_booking_rate, paid_minutes
        ) VALUES ($1, 'Phase Two Protocol Expert', 'Builds ERC-20 streaming and verifier-backed payment systems.', 180, $2, true, 96, 'today', 'UTC-5', $3, 'verified', 3600, 0.96, 0.4, 1200)`,
        [users.provider, ['Solidity', 'Streaming', 'DeFi'], ['en']]
      )
    }
  })
}

let databaseReady = false
try {
  if (process.env.SMOKE_DATABASE_ISOLATED !== 'true') {
    throw new Error('SMOKE_DATABASE_ISOLATED=true is required; the smoke harness refuses non-isolated databases')
  }
  if (config.isProd || config.payments.mainnetEnabled || config.payments.settlementChainId !== 84532) {
    throw new Error('controlled smoke harness requires non-production Base Sepolia with mainnet settlement disabled')
  }
  const registry = parseTokenRegistry(config.payments.tokenRegistry)
  const smokeToken = registry.resolve(84532, process.env.SMOKE_TOKEN_ADDRESS || registry.list({ chainId: 84532, enabledOnly: true })[0]?.address)
  if (!smokeToken || !smokeToken.enabled) {
    throw new Error('SMOKE_TOKEN_ADDRESS must resolve to an enabled Base Sepolia token registry entry')
  }
  tokenAddress = smokeToken.address
  await initializeDatabase()
  databaseReady = true
  await ensureProfile()
  const clientToken = await login(client)
  const providerToken = await login(provider)
  let operatorToken = null
  if (process.env.RUN_VERIFIER_PILOT === 'true') {
    config.auth.operatorWallets.push(operator.address.toLowerCase())
    operatorToken = await login(operator)
  }

  const discovery = await request(app)
    .get('/api/v2/discovery/experts?q=streaming&availability=today')
    .set('Authorization', `Bearer ${clientToken}`)
  assert.equal(discovery.status, 200)
  assert.equal(discovery.body.ranking.version, 1)
  assert.ok(discovery.body.count >= 1)
  const expert = discovery.body.experts[0]

  const engagement = await request(app)
    .post('/api/v2/engagements')
    .set('Authorization', `Bearer ${clientToken}`)
    .send({
      providerWallet: expert.wallet,
      searchBrief: 'Need a resilient ERC-20 streaming adapter for a testnet pilot.',
      discoveryContext: { queryId: discovery.body.queryId, expertId: expert.id, matchedFilters: expert.matchExplanation.matchedFilters },
      rankingExplanation: expert.matchExplanation,
      proposedTerms: { chainId: 84532, tokenAddress, ratePerSecondBaseUnits: '3472' },
      matchSessionId: `phase2-${Date.now()}`
    })
  assert.equal(engagement.status, 201)
  assert.equal(engagement.body.engagement.collaboration_status, 'ready')
  assert.equal(engagement.body.engagement.payment_status, 'not_requested')

  const handoff = await request(app)
    .get(`/api/v2/engagements/${engagement.body.engagement.id}`)
    .set('Authorization', `Bearer ${providerToken}`)
  assert.equal(handoff.status, 200)
  assert.equal(handoff.body.engagement.thread_id, engagement.body.engagement.thread_id)

  const collaboration = await request(app)
    .post(`/api/v2/engagements/${engagement.body.engagement.id}/collaboration-state`)
    .set('Authorization', `Bearer ${providerToken}`)
    .send({ status: 'active' })
  assert.equal(collaboration.status, 200)

  const intent = await request(app)
    .post('/api/v2/payment-intents')
    .set('Authorization', `Bearer ${clientToken}`)
    .send({
      recipientWallet: expert.wallet,
      chainId: 84532,
      tokenAddress,
      amountBaseUnits: '12500000',
      ratePerSecondBaseUnits: '3472',
      idempotencyKey: `phase2-loop-${Date.now()}`,
      engagementId: engagement.body.engagement.id
    })
  assert.equal(intent.status, 201)

  const attached = await request(app)
    .post(`/api/v2/engagements/${engagement.body.engagement.id}/payment-intent`)
    .set('Authorization', `Bearer ${clientToken}`)
    .send({ paymentIntentId: intent.body.intent.id })
  assert.equal(attached.status, 200)
    assert.equal(attached.body.engagement.payment_status, 'intent_created')

  let verifierResult = null
  if (operatorToken) {
    const verifierTransactionHash = `0x${intent.body.intent.id.replaceAll('-', '')}${'0'.repeat(32)}`
    const verifierBlockHash = `0x${intent.body.intent.id.replaceAll('-', '')}${'1'.repeat(32)}`
    const verifiedEvent = await request(app)
      .post('/api/v2/verifier/chain-events')
      .set('Authorization', `Bearer ${operatorToken}`)
      .send({
        intentId: intent.body.intent.id,
        event: {
          type: 'stream_created',
          finalityStatus: 'included',
          streamProtocolId: `ci-${intent.body.intent.id}`,
          chainId: 84532,
          protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d',
          tokenAddress,
          senderWallet: client.address,
          recipientWallet: provider.address,
          transactionHash: verifierTransactionHash,
          blockNumber: 123,
          blockHash: verifierBlockHash,
          logIndex: 0,
          amountBaseUnits: '12500000',
          rawPayload: { source: 'ci-verifier-pilot' }
        }
      })
    assert.equal(verifiedEvent.status, 200)
    assert.equal(verifiedEvent.body.authority, 'verifier_owned_chain_evidence')
    assert.equal(verifiedEvent.body.stream.lifecycleState, 'chain_included')
    verifierResult = { streamId: verifiedEvent.body.stream.id, lifecycleState: verifiedEvent.body.stream.lifecycleState }
  }

  const outcomeBody = {
    eventType: 'meeting_completed',
    evidenceType: 'session',
    evidenceId: `session-${Date.now()}`,
    payload: { durationSeconds: 1800 }
  }
  const outcome = await request(app)
    .post(`/api/v2/engagements/${engagement.body.engagement.id}/outcomes`)
    .set('Authorization', `Bearer ${clientToken}`)
    .send(outcomeBody)
  assert.equal(outcome.status, 201)
  assert.equal(outcome.body.verificationStatus, 'unverified')

  const outcomeReplay = await request(app)
    .post(`/api/v2/engagements/${engagement.body.engagement.id}/outcomes`)
    .set('Authorization', `Bearer ${clientToken}`)
    .send(outcomeBody)
  assert.equal(outcomeReplay.status, 200)
  assert.equal(outcomeReplay.body.idempotentReplay, true)

  console.log(JSON.stringify({
    reportKind: 'smoke_phase2_evidence',
    status: 'ok',
    releaseCommit: process.env.SMOKE_PHASE2_EVIDENCE_COMMIT || null,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'controlled_smoke_evidence',
    experts: discovery.body.count,
    engagementId: engagement.body.engagement.id,
    threadId: engagement.body.engagement.thread_id,
    paymentIntentId: intent.body.intent.id,
    verifierResult,
    outcomeReplay: outcomeReplay.body.idempotentReplay,
    smokeBoundary: {
      isolatedDatabase: true,
      chainId: config.payments.settlementChainId,
      mainnetEnabled: config.payments.mainnetEnabled,
      tokenAddress,
      chainTransactionSubmitted: false,
      settlementMutationPerformed: false
    }
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    reportKind: 'smoke_phase2_evidence',
    status: 'blocked',
    releaseCommit: process.env.SMOKE_PHASE2_EVIDENCE_COMMIT || null,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    applied: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'controlled_smoke_evidence',
    reason: error.message,
    chainTransactionSubmitted: false
  }, null, 2))
  process.exitCode = 1
} finally {
  if (databaseReady) {
    await cleanupSmokeData().catch((error) => console.error(JSON.stringify({ status: 'cleanup_failed', reason: error.message })))
  }
  await closeDatabase()
}
