import config from '../lib/config.js'
import { parseTokenRegistry } from '../lib/payments/tokenRegistry.js'
import { BASE_SEPOLIA_SABLIER_FLOW_V3, createBaseSepoliaFlowVerifier } from '../lib/payments/sablierFlowV3.js'
import { validateTokenRegistryMetadata } from '../lib/payments/tokenMetadataProbe.js'

let exitCode
try {
  if (!config.payments.rpcUrl) throw new Error('PAYMENT_RPC_URL is required for read-only token metadata validation')
  const verifier = createBaseSepoliaFlowVerifier({
    rpcUrl: config.payments.rpcUrl,
    contractAddress: config.payments.protocolContractAddress || BASE_SEPOLIA_SABLIER_FLOW_V3
  })
  const result = await validateTokenRegistryMetadata({
    provider: verifier.provider,
    registry: parseTokenRegistry(config.payments.tokenRegistry),
    chainId: config.payments.settlementChainId
  })
      console.log(JSON.stringify({
      reportKind: 'token_metadata_evidence',
      ...result,
      ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
    }, null, 2))
    exitCode = result.status === 'matched' ? 0 : 1

} catch (error) {
      console.error(JSON.stringify({
    reportKind: 'token_metadata_evidence',
    status: 'blocked',

    reason: error.message,
    authority: 'read_only_rpc_metadata',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
  }, null, 2))
  exitCode = 1
}

process.exitCode = exitCode
