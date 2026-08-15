import { describe, expect, it } from 'vitest'
import { createTokenRegistry } from '../lib/payments/tokenRegistry.js'
import { validateTokenRegistryMetadata } from '../lib/payments/tokenMetadataProbe.js'

const token = {
  chainId: 84532,
  address: '0x1111111111111111111111111111111111111111',
  decimals: 6,
  symbol: 'USDC',
  protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'
}

describe('ERC-20 token metadata probe', () => {
  it('matches configured token metadata on the configured chain without mutation', async () => {
    const result = await validateTokenRegistryMetadata({
      provider: { async getNetwork() { return { chainId: 84532n } } },
      registry: createTokenRegistry([token]),
      chainId: 84532,
      readMetadata: async () => ({ symbol: 'usdc', decimals: 6 })
    })
    expect(result).toMatchObject({ status: 'matched', actualChainId: 84532, authority: 'read_only_rpc_metadata', mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
    expect(result.tokens[0]).toMatchObject({ status: 'matched', symbolMatch: true, decimalsMatch: true })
  })

  it('blocks an RPC chain mismatch before reading token metadata', async () => {
    let readCount = 0
    const result = await validateTokenRegistryMetadata({
      provider: { async getNetwork() { return { chainId: 8453n } } },
      registry: createTokenRegistry([token]),
      chainId: 84532,
      readMetadata: async () => { readCount += 1; return token }
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('does not match configured settlement chain')
    expect(readCount).toBe(0)
  })

  it('blocks mismatched decimals or symbol and unreadable token metadata', async () => {
    const mismatch = await validateTokenRegistryMetadata({
      provider: { async getNetwork() { return { chainId: 84532n } } },
      registry: createTokenRegistry([token]),
      chainId: 84532,
      readMetadata: async () => ({ symbol: 'DAI', decimals: 18 })
    })
    expect(mismatch.status).toBe('blocked')
    expect(mismatch.tokens[0]).toMatchObject({ status: 'mismatch', symbolMatch: false, decimalsMatch: false })

    const unreadable = await validateTokenRegistryMetadata({
      provider: { async getNetwork() { return { chainId: 84532n } } },
      registry: createTokenRegistry([token]),
      chainId: 84532,
      readMetadata: async () => { throw new Error('RPC call failed') }
    })
    expect(unreadable).toMatchObject({ status: 'blocked', tokens: [{ status: 'unreadable', reason: 'RPC call failed' }] })
  })
})
