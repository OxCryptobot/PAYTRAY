import config, { validateConfig } from '../lib/config.js'
import { parseTokenRegistry } from '../lib/payments/tokenRegistry.js'

try {
  validateConfig()
  if (!config.verifierWorker.enabled) throw new Error('VERIFIER_WORKER_ENABLED=true is required')
  if (!config.database.url) throw new Error('DATABASE_URL is required')
  if (config.payments.settlementChainId !== 84532) throw new Error('VERIFIER_WORKER_ENABLED requires Base Sepolia chain ID 84532')
  if (config.payments.mainnetEnabled) throw new Error('VERIFIER_WORKER_ENABLED cannot run with PAYMENT_MAINNET_ENABLED=true')
  if (!/^https:\/\//i.test(config.payments.rpcUrl || '')) throw new Error('PAYMENT_RPC_URL must use HTTPS')
  if (!config.payments.protocolContractAddress) throw new Error('PAYMENT_STREAM_PROTOCOL_CONTRACT is required')
  const tokenRegistry = parseTokenRegistry(config.payments.tokenRegistry)
  const settlement = tokenRegistry.validateSettlementConfiguration({
    chainId: config.payments.settlementChainId,
    protocolContractAddress: config.payments.protocolContractAddress,
    protocol: config.payments.protocol
  })

  console.log(JSON.stringify({
    status: 'ready',
    worker: 'base_sepolia_verifier',
    enabled: true,
    chainId: config.payments.settlementChainId,
    protocol: config.payments.protocol,
    protocolContractConfigured: true,
    rpcTransport: 'https_required',
    pollIntervalMs: config.verifierWorker.pollIntervalMs,
    maxBlockRange: config.verifierWorker.maxBlockRange,
    finalityConfirmations: config.verifierWorker.finalityConfirmations,
    verifierId: config.verifierWorker.verifierId,
    enabledTokenCount: settlement.enabledTokens.length,
    cursorPersistence: 'postgresql_payment_verifier_cursors',
    projectionBoundary: 'verified_chain_event_to_ledger_projection',
    settlementAuthority: false,
    mutation: 'verifier_projection_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    worker: 'base_sepolia_verifier',
    reason: error.message,
    settlementAuthority: false,
    mutation: 'none',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
