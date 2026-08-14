import { describe, expect, it } from 'vitest'
import { createChainVerifierWorker } from '../lib/payments/chainVerifierWorker.js'
import { createProtocolAdapter } from '../lib/payments/protocolAdapter.js'
import { createTokenRegistry } from '../lib/payments/tokenRegistry.js'

describe('Paytray chain verifier worker', () => {
  const token = {
    chainId: 84532,
    address: '0x1111111111111111111111111111111111111111',
    decimals: 6,
    symbol: 'USDC',
    protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'
  }

  it('scans a bounded block range, projects decoded events, and advances the durable cursor', async () => {
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({
      protocol: 'sablier-flow-v3',
      chainId: 84532,
      contractAddress: token.protocolContractAddress,
      tokenRegistry: registry
    })
    const cursorWrites = []
    const projections = []
    const event = {
      type: 'stream_created',
      finalityStatus: 'included',
      streamProtocolId: '42',
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x2222222222222222222222222222222222222222',
      recipientWallet: '0x3333333333333333333333333333333333333333',
      transactionHash: `0x${'a'.repeat(64)}`,
      blockNumber: 101,
      blockHash: `0x${'b'.repeat(64)}`,
      logIndex: 0,
      amountBaseUnits: '10000000',
      rawPayload: { streamId: '42' }
    }
    const worker = createChainVerifierWorker({
      provider: {
        async getBlockNumber() { return 105 },
        async getLogs(filter) {
          expect(filter).toEqual({
            address: adapter.contractAddress,
            fromBlock: 101,
            toBlock: 103
          })
          return [{ blockNumber: 101 }, { blockNumber: 102 }]
        }
      },
      adapter,
      tokenRegistry: registry,
      repository: {
        async recordChainEvent() {
          return { event: { id: 'event-1' }, idempotentReplay: false }
        }
      },
      async getStream() {
        return {
          id: 'paytray-stream-1',
          lifecycleState: 'wallet_submitted',
          chainId: 84532,
          protocolContractAddress: token.protocolContractAddress,
          tokenAddress: token.address,
          senderWallet: event.senderWallet,
          recipientWallet: event.recipientWallet
        }
      },
      async projectStream(stream) { projections.push(stream) },
      async decodeLog() { return event },
      async loadCursor() { return 100 },
      async saveCursor(chainId, block) { cursorWrites.push({ chainId, block }) },
      maxBlockRange: 3
    })

    const result = await worker.pollOnce()

    expect(result).toMatchObject({ fromBlock: 101, toBlock: 103, logs: 2, projected: 2, replays: 0 })
    expect(cursorWrites).toEqual([{ chainId: 84532, block: 103 }])
    expect(projections).toHaveLength(2)
  })

  it('promotes an event to finalized after the configured confirmation threshold', async () => {
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({ protocol: 'sablier-flow-v3', chainId: 84532, contractAddress: token.protocolContractAddress, tokenRegistry: registry })
    const finalityStatuses = []
    const worker = createChainVerifierWorker({
      provider: { async getBlockNumber() { return 110 }, async getLogs() { return [{ blockNumber: 101 }] } },
      adapter,
      tokenRegistry: registry,
      repository: { async recordChainEvent(input) { finalityStatuses.push(input.finalityStatus); return { event: { id: 'event-finalized' }, idempotentReplay: false } } },
      async getStream() { return { id: 'paytray-stream-1', lifecycleState: 'wallet_submitted', chainId: 84532, protocolContractAddress: token.protocolContractAddress, tokenAddress: token.address, senderWallet: eventSender(), recipientWallet: eventRecipient() } },
      async projectStream() {},
      async decodeLog() { return { ...baseEvent(), blockNumber: 101 } },
      async loadCursor() { return 100 },
      async saveCursor() {},
      finalityConfirmations: 10
    })
    await worker.pollOnce()
    expect(finalityStatuses).toEqual(['finalized'])
  })

  it('does not scan when the durable cursor is already at the chain tip', async () => {
    let queried = false
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({
      protocol: 'sablier-flow-v3',
      chainId: 84532,
      contractAddress: token.protocolContractAddress,
      tokenRegistry: registry
    })
    const worker = createChainVerifierWorker({
      provider: {
        async getBlockNumber() { return 100 },
        async getLogs() { queried = true; return [] }
      },
      adapter,
      tokenRegistry: registry,
      repository: { async recordChainEvent() { return { event: null, idempotentReplay: false } } },
      async getStream() { return null },
      async projectStream() {},
      async decodeLog() { return null },
      async loadCursor() { return 100 },
      async saveCursor() {}
    })

    const result = await worker.pollOnce()

    expect(result.logs).toBe(0)
    expect(queried).toBe(false)
  })
})

function eventSender() { return '0x2222222222222222222222222222222222222222' }
function eventRecipient() { return '0x3333333333333333333333333333333333333333' }
function baseEvent() {
  return {
    type: 'stream_created', finalityStatus: 'included', streamProtocolId: '42', chainId: 84532,
    protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d', tokenAddress: '0x1111111111111111111111111111111111111111',
    senderWallet: eventSender(), recipientWallet: eventRecipient(), transactionHash: `0x${'a'.repeat(64)}`,
    blockNumber: 101, blockHash: `0x${'b'.repeat(64)}`, logIndex: 0, amountBaseUnits: '10000000', rawPayload: { streamId: '42' }
  }
}
