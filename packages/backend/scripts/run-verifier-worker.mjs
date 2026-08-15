import config, { validateConfig } from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, getPool, initializeDatabase } from '../lib/database.js'
import { parseTokenRegistry } from '../lib/payments/tokenRegistry.js'
import { createConfiguredBaseSepoliaVerifierWorker } from '../lib/payments/verifierWorkerService.js'

let stopping = false
let timer = null
let activeClient = null

function log(level, message, data = {}) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    worker: 'base_sepolia_verifier',
    message,
    ...data,
    settlementAuthority: false,
    mutation: 'verifier_projection_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
  const output = JSON.stringify(payload)
  if (level === 'ERROR') console.error(output)
  else console.log(output)
}

async function main() {
  validateConfig()
  if (!config.verifierWorker.enabled) throw new Error('VERIFIER_WORKER_ENABLED=true is required')
  if (!config.database.url) throw new Error('DATABASE_URL is required')
  if (config.payments.settlementChainId !== 84532) throw new Error('VERIFIER_WORKER_ENABLED requires Base Sepolia chain ID 84532')
  if (config.payments.mainnetEnabled) throw new Error('VERIFIER_WORKER_ENABLED cannot run with PAYMENT_MAINNET_ENABLED=true')
  if (!/^https:\/\//i.test(config.payments.rpcUrl || '')) throw new Error('PAYMENT_RPC_URL must use HTTPS')
  if (!config.payments.protocolContractAddress) throw new Error('PAYMENT_STREAM_PROTOCOL_CONTRACT is required')

  const tokenRegistry = parseTokenRegistry(config.payments.tokenRegistry)
  tokenRegistry.validateSettlementConfiguration({
    chainId: config.payments.settlementChainId,
    protocolContractAddress: config.payments.protocolContractAddress,
    protocol: config.payments.protocol
  })

  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('database is not ready')
  const pool = getPool()
  const workerOptions = {
    rpcUrl: config.payments.rpcUrl,
    tokenRegistry,
    contractAddress: config.payments.protocolContractAddress,
    maxBlockRange: config.verifierWorker.maxBlockRange,
    finalityConfirmations: config.verifierWorker.finalityConfirmations,
    verifierId: config.verifierWorker.verifierId
  }

  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    if (timer) clearTimeout(timer)
    log('INFO', 'shutdown_requested', { signal })
    await closeDatabase()
  }
  process.once('SIGTERM', () => { void stop('SIGTERM') })
  process.once('SIGINT', () => { void stop('SIGINT') })

  const tick = async () => {
    if (stopping) return
    const startedAt = Date.now()
    try {
      activeClient = await pool.connect()
      await activeClient.query('BEGIN')
      const worker = createConfiguredBaseSepoliaVerifierWorker({ client: activeClient, ...workerOptions })
      const result = await worker.pollOnce({})
      await activeClient.query('COMMIT')
      activeClient.release()
      activeClient = null
      log('INFO', 'poll_completed', {
        ...result,
        durationMs: Date.now() - startedAt,
        verifierId: config.verifierWorker.verifierId
      })
    } catch (error) {
      if (activeClient) {
        await activeClient.query('ROLLBACK').catch(() => {})
        activeClient.release()
        activeClient = null
      }
      log('ERROR', 'poll_failed', { reason: error.message, durationMs: Date.now() - startedAt })
    } finally {
      if (!stopping) timer = setTimeout(() => { void tick() }, config.verifierWorker.pollIntervalMs)
    }
  }

  log('INFO', 'worker_started', {
    chainId: config.payments.settlementChainId,
    protocol: config.payments.protocol,
    pollIntervalMs: config.verifierWorker.pollIntervalMs,
    maxBlockRange: config.verifierWorker.maxBlockRange,
    finalityConfirmations: config.verifierWorker.finalityConfirmations,
    verifierId: config.verifierWorker.verifierId
  })
  await tick()
}

try {
  await main()
} catch (error) {
  log('ERROR', 'worker_blocked', { reason: error.message, mutation: 'none' })
  await closeDatabase().catch(() => {})
  process.exitCode = 1
}
