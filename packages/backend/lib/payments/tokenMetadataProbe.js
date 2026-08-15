import { Contract } from 'ethers'

const ERC20_METADATA_ABI = [
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
]

export async function readErc20Metadata({ provider, address }) {
  if (!provider || typeof provider.getNetwork !== 'function') {
    throw new Error('A provider is required for ERC-20 metadata inspection')
  }
  const contract = new Contract(address, ERC20_METADATA_ABI, provider)
  const [decimals, symbol] = await Promise.all([contract.decimals(), contract.symbol()])
  return { decimals: Number(decimals), symbol: String(symbol) }
}

export async function validateTokenRegistryMetadata({ provider, registry, chainId, readMetadata = readErc20Metadata }) {
  const expectedChainId = Number(chainId)
  const network = await provider.getNetwork()
  const actualChainId = Number(network.chainId)
  if (actualChainId !== expectedChainId) {
    return {
      status: 'blocked',
      reason: `RPC chain ID ${actualChainId} does not match configured settlement chain ${expectedChainId}`,
      chainId: expectedChainId,
      actualChainId,
      tokens: [],
      authority: 'read_only_rpc_metadata',
      mutation: 'read_only'
    }
  }

  const tokens = registry.list({ chainId: expectedChainId, enabledOnly: true })
  if (tokens.length === 0) {
    return {
      status: 'blocked',
      reason: `No enabled token is configured for settlement chain ${expectedChainId}`,
      chainId: expectedChainId,
      actualChainId,
      tokens: [],
      authority: 'read_only_rpc_metadata',
      mutation: 'read_only'
    }
  }

  const results = []
  for (const token of tokens) {
    try {
      const observed = await readMetadata({ provider, address: token.address })
      const decimalsMatch = observed.decimals === token.decimals
      const symbolMatch = observed.symbol.toUpperCase() === token.symbol.toUpperCase()
      results.push({
        address: token.address,
        configured: { symbol: token.symbol, decimals: token.decimals },
        observed,
        status: decimalsMatch && symbolMatch ? 'matched' : 'mismatch',
        decimalsMatch,
        symbolMatch
      })
    } catch (error) {
      results.push({
        address: token.address,
        configured: { symbol: token.symbol, decimals: token.decimals },
        observed: null,
        status: 'unreadable',
        reason: error.message
      })
    }
  }

  const invalid = results.filter((token) => token.status !== 'matched')
  return {
    status: invalid.length === 0 ? 'matched' : 'blocked',
    reason: invalid.length === 0 ? 'all enabled token metadata matches the configured registry' : `${invalid.length} enabled token metadata record(s) failed validation`,
    chainId: expectedChainId,
    actualChainId,
    tokens: results,
    authority: 'read_only_rpc_metadata',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export { ERC20_METADATA_ABI }
