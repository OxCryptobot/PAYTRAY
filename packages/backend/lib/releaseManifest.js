import crypto from 'crypto'

export function buildReleaseManifest({ config, gitCommit = null, dirty = false, artifacts = [], generatedAt = new Date().toISOString() }) {
  const production = config.env === 'production'
  const checks = [
    { name: 'gitCommit', ready: typeof gitCommit === 'string' && /^[0-9a-f]{7,64}$/i.test(gitCommit), reason: 'release commit is identified' },
    { name: 'cleanWorktree', ready: dirty === false, reason: dirty === false ? 'release worktree is clean' : 'release worktree has uncommitted changes' },
    { name: 'testnetDefault', ready: config.payments.settlementChainId === 84532 || (config.payments.settlementChainId === 8453 && config.payments.mainnetEnabled === true), reason: 'settlement chain and mainnet policy are explicit' },
    { name: 'productionRpc', ready: !production || /^https:\/\//i.test(config.payments.rpcUrl || ''), reason: 'production settlement RPC uses HTTPS' },
    { name: 'artifactEvidence', ready: artifacts.length > 0 && artifacts.every((artifact) => artifact.path && /^[0-9a-f]{64}$/i.test(artifact.sha256)), reason: 'runtime artifact hashes are present' }
  ]
  const manifestHash = crypto.createHash('sha256').update(JSON.stringify({ gitCommit, dirty, artifacts, settlement: { chainId: config.payments.settlementChainId, protocol: config.payments.protocol, mainnetEnabled: config.payments.mainnetEnabled } })).digest('hex')
  return {
    status: checks.every((check) => check.ready) ? 'ready' : 'blocked',
    generatedAt,
    gitCommit,
    dirty,
    settlement: { chainId: config.payments.settlementChainId, protocol: config.payments.protocol, mainnetEnabled: config.payments.mainnetEnabled },
    artifacts,
    manifestHash,
    checks,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}
