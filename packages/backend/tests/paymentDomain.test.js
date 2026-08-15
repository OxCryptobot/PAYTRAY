import { describe, expect, it } from 'vitest'
import {
  PaymentLifecycleError,
  assertPaymentTransition,
  getAllowedTransitions,
  transitionPaymentStream
} from '../lib/payments/paymentLifecycle.js'
import {
  TokenRegistryError,
  createTokenRegistry,
  parseTokenRegistry
} from '../lib/payments/tokenRegistry.js'
import {
  ProtocolAdapterError,
  assertEventMatchesStream,
  createProtocolAdapter
} from '../lib/payments/protocolAdapter.js'
import { applyVerifiedProtocolEvent, VerifierServiceError } from '../lib/payments/verifierService.js'

describe('Paytray payment domain foundations', () => {
  const token = {
    chainId: 84532,
    address: '0x1111111111111111111111111111111111111111',
    decimals: 6,
    symbol: 'USDC',
    protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'
  }

  it('stores token identity by chain, checksum address, decimals, and enablement status', () => {
    const registry = createTokenRegistry([token])
    const resolved = registry.requireEnabled(84532, token.address.toLowerCase())

    expect(resolved.chainId).toBe(84532)
    expect(resolved.address).toBe('0x1111111111111111111111111111111111111111')
    expect(resolved.decimals).toBe(6)
    expect(resolved.protocolContractAddress).toBe('0xC1BA5A41936aaAB0Ff920446DB556efe17Fc1C5D')
  })

  it('rejects arbitrary symbols, duplicate tokens, and invalid registry data', () => {
    expect(() => createTokenRegistry([{ ...token, address: 'USDC' }])).toThrow(TokenRegistryError)
    expect(() => createTokenRegistry([token, token])).toThrow('Duplicate token registry entry')
    expect(() => parseTokenRegistry('{invalid json}')).toThrow('Token registry must be valid JSON')
  })

  it('requires enabled settlement tokens to match the configured chain and protocol contract', () => {
    const registry = createTokenRegistry([token])
    expect(registry.validateSettlementConfiguration({
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress
    })).toMatchObject({
      chainId: 84532,
      protocol: 'sablier-flow-v3',
      enabledTokens: [{ symbol: 'USDC', decimals: 6 }]
    })
    expect(() => registry.validateSettlementConfiguration({
      chainId: 84532,
      protocolContractAddress: '0x2222222222222222222222222222222222222222'
    })).toThrow('protocol contract does not match')
    expect(() => createTokenRegistry([{ ...token, protocolContractAddress: null }]).validateSettlementConfiguration({
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress
    })).toThrow('missing its sablier-flow-v3 protocol contract address')
  })

  it('limits chain-finalized and ledger-reflected states to verifier-owned sources', () => {
    expect(() => assertPaymentTransition({ from: 'chain_included', to: 'chain_finalized', source: 'api' }))
      .toThrow('is not owned by api')

    expect(assertPaymentTransition({ from: 'chain_included', to: 'chain_finalized', source: 'verifier' })).toBe(true)
    expect(assertPaymentTransition({ from: 'chain_finalized', to: 'ledger_reflected', source: 'ledger_worker' })).toBe(true)
    expect(getAllowedTransitions('ledger_reflected')).toContain('withdrawal_pending')
  })

  it('maintains an auditable transition history', () => {
    const intent = transitionPaymentStream(
      { id: 'stream-1', lifecycleState: 'draft' },
      { to: 'intent_created', source: 'api', occurredAt: '2026-08-14T00:00:00.000Z', evidence: { idempotencyKey: 'intent-1' } }
    )
    const submitted = transitionPaymentStream(
      intent,
      { to: 'wallet_submitted', source: 'wallet', occurredAt: '2026-08-14T00:00:01.000Z', evidence: { transactionHash: '0xabc' } }
    )

    expect(submitted.lifecycleState).toBe('wallet_submitted')
    expect(submitted.lifecycleHistory).toHaveLength(2)
    expect(submitted.lifecycleHistory[1].evidence.transactionHash).toBe('0xabc')
  })

  it('validates protocol events against the selected chain, contract, and enabled token registry', () => {
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({
      protocol: 'sablier-flow-v3',
      chainId: 84532,
      contractAddress: token.protocolContractAddress,
      tokenRegistry: registry
    })

    const event = adapter.validateEvent({
      type: 'stream_created',
      finalityStatus: 'included',
      streamProtocolId: '42',
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x2222222222222222222222222222222222222222',
      recipientWallet: '0x3333333333333333333333333333333333333333',
      transactionHash: `0x${'a'.repeat(64)}`,
      blockNumber: 100,
      blockHash: `0x${'b'.repeat(64)}`,
      logIndex: 2,
      amountBaseUnits: '12500000'
    })

    expect(event.amountBaseUnits).toBe('12500000')
    expect(() => adapter.validateEvent({ ...event, tokenAddress: '0x4444444444444444444444444444444444444444' }))
      .toThrow('Token is not in the Paytray registry')
  })

  it('rejects a protocol event whose identity does not match the durable stream record', () => {
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({
      protocol: 'sablier-flow-v3',
      chainId: 84532,
      contractAddress: token.protocolContractAddress,
      tokenRegistry: registry
    })
    const event = adapter.validateEvent({
      type: 'withdrawal',
      finalityStatus: 'finalized',
      streamProtocolId: '42',
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x2222222222222222222222222222222222222222',
      recipientWallet: '0x3333333333333333333333333333333333333333',
      transactionHash: `0x${'c'.repeat(64)}`,
      blockNumber: 101,
      blockHash: `0x${'d'.repeat(64)}`,
      logIndex: 0,
      amountBaseUnits: '5000000'
    })

    expect(assertEventMatchesStream({
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: event.senderWallet,
      recipientWallet: event.recipientWallet
    }, event, registry).symbol).toBe('USDC')

    expect(() => assertEventMatchesStream({
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x5555555555555555555555555555555555555555',
      recipientWallet: event.recipientWallet
    }, event, registry)).toThrow(ProtocolAdapterError)
  })

  it('lets only verified protocol evidence advance a submitted stream to chain finality', () => {
    const registry = createTokenRegistry([token])
    const event = {
      type: 'stream_created',
      finalityStatus: 'finalized',
      streamProtocolId: '42',
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x2222222222222222222222222222222222222222',
      recipientWallet: '0x3333333333333333333333333333333333333333',
      transactionHash: `0x${'e'.repeat(64)}`,
      blockNumber: 102,
      blockHash: `0x${'f'.repeat(64)}`,
      logIndex: 0,
      amountBaseUnits: '10000000'
    }

    const finalized = applyVerifiedProtocolEvent({
      stream: {
        id: 'paytray-stream-1',
        lifecycleState: 'wallet_submitted',
        chainId: 84532,
        protocolContractAddress: token.protocolContractAddress,
        tokenAddress: token.address,
        senderWallet: event.senderWallet,
        recipientWallet: event.recipientWallet
      },
      event,
      tokenRegistry: registry,
      observedAt: '2026-08-14T00:00:10.000Z'
    })

    expect(finalized.lifecycleState).toBe('chain_finalized')
    expect(finalized.lifecycleHistory.map((entry) => entry.to)).toEqual([
      'chain_pending',
      'chain_included',
      'chain_finalized'
    ])
    expect(finalized.lastVerifiedEvent.transactionHash).toBe(event.transactionHash)
  })

  it('rejects invalidated events after ledger reflection and does not let a verifier write ledger state', () => {
    const registry = createTokenRegistry([token])
    const event = {
      type: 'stream_created',
      finalityStatus: 'reorged',
      streamProtocolId: '42',
      chainId: 84532,
      protocolContractAddress: token.protocolContractAddress,
      tokenAddress: token.address,
      senderWallet: '0x2222222222222222222222222222222222222222',
      recipientWallet: '0x3333333333333333333333333333333333333333',
      transactionHash: `0x${'a'.repeat(64)}`,
      blockNumber: 103,
      blockHash: `0x${'b'.repeat(64)}`,
      logIndex: 1,
      amountBaseUnits: '10000000'
    }

    expect(() => applyVerifiedProtocolEvent({
      stream: {
        lifecycleState: 'ledger_reflected',
        chainId: 84532,
        protocolContractAddress: token.protocolContractAddress,
        tokenAddress: token.address,
        senderWallet: event.senderWallet,
        recipientWallet: event.recipientWallet
      },
      event,
      tokenRegistry: registry
    })).toThrow(VerifierServiceError)
  })

  it('rejects invalid state or source transitions', () => {
    expect(() => assertPaymentTransition({ from: 'draft', to: 'ledger_reflected', source: 'ledger_worker' }))
      .toThrow(PaymentLifecycleError)
    expect(() => assertPaymentTransition({ from: 'unknown', to: 'draft', source: 'api' }))
      .toThrow('Unknown payment stream state')
  })
})
