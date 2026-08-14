import { describe, expect, it } from 'vitest'
import { createChainEventProcessor, hashEventPayload } from '../lib/payments/chainEventProcessor.js'
import { createProtocolAdapter } from '../lib/payments/protocolAdapter.js'
import { createTokenRegistry } from '../lib/payments/tokenRegistry.js'

describe('Paytray chain event processor', () => {
  const token = {
    chainId: 84532,
    address: '0x1111111111111111111111111111111111111111',
    decimals: 6,
    symbol: 'USDC',
    protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'
  }

  function createFixture({ idempotentReplay = false } = {}) {
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({
      protocol: 'sablier-flow-v3',
      chainId: 84532,
      contractAddress: token.protocolContractAddress,
      tokenRegistry: registry
    })
    const projected = []
    const processor = createChainEventProcessor({
      adapter,
      tokenRegistry: registry,
      repository: {
        async recordChainEvent() {
          return { event: { id: 'chain-event-1' }, idempotentReplay }
        }
      },
      async projectStream(stream, metadata) {
        projected.push({ stream, metadata })
      }
    })
    return { processor, projected }
  }

  function event(finalityStatus = 'included') {
    return {
      type: 'stream_created',
      finalityStatus,
      streamProtocolId: '42',
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x2222222222222222222222222222222222222222',
      recipientWallet: '0x3333333333333333333333333333333333333333',
      transactionHash: `0x${'a'.repeat(64)}`,
      blockNumber: 100,
      blockHash: `0x${'b'.repeat(64)}`,
      logIndex: 0,
      amountBaseUnits: '10000000',
      rawPayload: { b: 2, a: { y: 'two', x: 'one' } }
    }
  }

  function stream() {
    return {
      id: '00000000-0000-4000-8000-000000000010',
      lifecycleState: 'wallet_submitted',
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x2222222222222222222222222222222222222222',
      recipientWallet: '0x3333333333333333333333333333333333333333'
    }
  }

  it('hashes logically equivalent event payloads deterministically', () => {
    expect(hashEventPayload({ b: 2, a: { y: 'two', x: 'one' } }))
      .toBe(hashEventPayload({ a: { x: 'one', y: 'two' }, b: 2 }))
  })

  it('records a new included event and projects verifier-owned lifecycle state', async () => {
    const { processor, projected } = createFixture()
    const result = await processor.process({ stream: stream(), event: event(), correlationId: 'correlation-1' })

    expect(result.idempotentReplay).toBe(false)
    expect(result.projected).toBe(true)
    expect(result.stream.lifecycleState).toBe('chain_included')
    expect(projected).toHaveLength(1)
    expect(projected[0].metadata.chainEvent.id).toBe('chain-event-1')
  })

  it('reprojects a replayed chain event when lifecycle projection did not complete', async () => {
    const { processor, projected } = createFixture({ idempotentReplay: true })
    const result = await processor.process({ stream: stream(), event: event() })

    expect(result.idempotentReplay).toBe(true)
    expect(result.projected).toBe(true)
    expect(result.stream.lifecycleState).toBe('chain_included')
    expect(projected).toHaveLength(1)
    expect(projected[0].metadata.recovery).toBe(true)
  })

  it('does not reproject a replayed event after lifecycle projection already exists', async () => {
    const { processor, projected } = createFixture({ idempotentReplay: true })
    const original = { ...stream(), lifecycleState: 'chain_included' }
    const result = await processor.process({ stream: original, event: event() })

    expect(result.idempotentReplay).toBe(true)
    expect(result.projected).toBe(false)
    expect(result.stream).toBe(original)
    expect(projected).toHaveLength(0)
  })

  it('ignores a stale included event after finality without mutating the repository or stream', async () => {
    const { processor, projected } = createFixture()
    const original = {
      ...stream(),
      lifecycleState: 'chain_finalized',
      lastVerifiedEvent: { finalityStatus: 'finalized' }
    }
    const result = await processor.process({ stream: original, event: event('included') })

    expect(result).toMatchObject({ idempotentReplay: true, projected: false, ignored: true, reason: 'stale_non_finality_event' })
    expect(result.stream).toBe(original)
    expect(result.chainEvent).toBeNull()
    expect(projected).toHaveLength(0)
  })
})
