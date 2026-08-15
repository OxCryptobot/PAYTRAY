import request from 'supertest'
import { Wallet } from 'ethers'
import config from '../lib/config.js'
import app from '../server.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase } from '../lib/database.js'

const isolated = process.env.READY_POSTGRES_DATABASE_ISOLATED === 'true'
let exitCode = 1

if (!isolated) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: 'READY_POSTGRES_DATABASE_ISOLATED=true is required before exercising a database-backed route contract',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
} else {
  try {
    await initializeDatabase()
    if (getDatabaseStatus() !== 'ready') throw new Error('ready-PostgreSQL contract verifier requires database status ready')

    const wallet = Wallet.createRandom()
    config.auth.operatorWallets.push(wallet.address.toLowerCase())
    const challengeResponse = await request(app).post('/api/auth/challenge').send({ wallet: wallet.address })
    const challenge = challengeResponse.body.challenge
    const signature = await wallet.signMessage(challenge.message)
    const loginResponse = await request(app).post('/api/auth/login').send({
      wallet: wallet.address,
      signature,
      challengeId: challenge.id,
      message: challenge.message,
      scopes: ['ops:*', 'extensions:*']
    })
    if (loginResponse.status !== 200) throw new Error(`operator login failed with status ${loginResponse.status}`)
    const token = loginResponse.body.tokens.accessToken
    const auth = { Authorization: `Bearer ${token}` }

    const collaboration = await request(app).get('/api/v2/collaboration/health')
    const contracts = await request(app).get('/api/v2/extensions/contracts').set(auth)
    const hook = await request(app).post('/api/v2/extensions/hooks').set(auth).send({ event: 'engagement.created', callbackUrl: 'https://example.com/paytray-contract-check', projections: ['identifiers', 'lifecycle'] })
    const hooks = await request(app).get('/api/v2/extensions/hooks').set(auth)
    const audit = await request(app).get('/api/v2/ops/audit/events').set(auth)
    const lineage = await request(app).get('/api/v2/ops/discovery/lineage').set(auth)
    const outbox = await request(app).get('/api/v2/ops/outbox/health').set(auth)
    const verifier = await request(app).get('/api/v2/ops/verifier/operations').set(auth)

    const checks = {
      collaboration: collaboration.status === 200 && collaboration.body.health?.collaborationAvailable === true,
      extensionContracts: contracts.status === 200 && contracts.body.contracts?.apiVersion === 'v2',
      extensionRegistration: hook.status === 200 && hooks.status === 200,
      audit: audit.status === 200 && Array.isArray(audit.body.audit?.events),
      lineage: lineage.status === 200 && Array.isArray(lineage.body.lineage?.impressions),
      outbox: outbox.status === 200 && outbox.body.health?.mutation === 'read_only',
      verifier: [200, 503].includes(verifier.status) && verifier.body.evidence?.mutation === 'read_only'
    }
    const ready = Object.values(checks).every(Boolean)
    console.log(JSON.stringify({
      status: ready ? 'verified' : 'blocked',
      databaseStatus: getDatabaseStatus(),
      checks,
      routeStatuses: { collaboration: collaboration.status, contracts: contracts.status, hook: hook.status, hooks: hooks.status, audit: audit.status, lineage: lineage.status, outbox: outbox.status, verifier: verifier.status },
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
    exitCode = ready ? 0 : 1
  } catch (error) {
    console.error(JSON.stringify({
      status: 'blocked',
      reason: error.message,
      databaseStatus: getDatabaseStatus(),
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
    exitCode = 1
  } finally {
    await closeDatabase().catch(() => {})
  }
  process.exitCode = exitCode
}
