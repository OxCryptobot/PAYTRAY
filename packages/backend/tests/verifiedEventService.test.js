import { describe, expect, it } from 'vitest'
import { createTokenRegistry } from '../lib/payments/tokenRegistry.js'
import { processVerifiedChainEvent } from '../lib/payments/verifiedEventService.js'

const token = {
  chainId: 84532,
  address: '0x1111111111111111111111111111111111111111',
  decimals: 6,
  symbol: 'USDC',
  protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'
}

const config = {
  payments: {
    protocol: 'sablier-flow-v3',
    settlementChainId: 84532,
    protocolContractAddress: token.protocolContractAddress
  }
}

function event() {
  return {
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
    logIndex: 0,
    amountBaseUnits: '10000000',
    rawPayload: { streamProtocolId: '42' }
  }
}

function streamRow() {
  return {
    id: '00000000-0000-4000-8000-000000000010',
    lifecycle_state: 'wallet_submitted',
    chain_id: 84532,
    protocol_contract_address: token.protocolContractAddress,
    token_address: token.address,
    sender_wallet: '0x2222222222222222222222222222222222222222',
    recipient_wallet: '0x3333333333333333333333333333333333333333'
  }
}

describe('verifier-owned chain event service', () => {
  it('projects verified lifecycle state and writes an audit record', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT ps.*')) return { rows: [streamRow()] }
        if (sql.includes('INSERT INTO payment_chain_events')) return { rows: [{ id: 'chain-event-1', finality_status: 'included' }] }
        if (sql.includes('UPDATE payment_streams')) return { rows: [{ id: streamRow().id }] }
        if (sql.includes('INSERT INTO financial_audit_events')) return { rows: [{ id: 'audit-1' }] }
        if (sql.includes('INSERT INTO outbox_events')) return { rows: [{ id: 'outbox-1', aggregate_type: 'payment_stream', aggregate_id: streamRow().id, event_type: 'payment.chain_event.projected', payload: {}, correlation_id: null, occurred_at: new Date().toISOString(), available_at: new Date().toISOString(), processed_at: null, attempts: 0, last_error: null }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const result = await processVerifiedChainEvent({ client, config, tokenRegistry: createTokenRegistry([token]), streamId: streamRow().id, event: event(), verifierId: '0xoperator' })
    expect(result.projected).toBe(true)
    expect(result.stream.lifecycleState).toBe('chain_included')
    expect(calls.some((call) => call.sql.includes('UPDATE payment_streams'))).toBe(true)
    expect(calls.some((call) => call.sql.includes('INSERT INTO financial_audit_events'))).toBe(true)
  })

  it('provisions a stream from a payment intent before projecting verified creation', async () => {
    const calls = []
    const provisionedRow = {
      ...streamRow(),
      id: '00000000-0000-4000-8000-000000000011',
      lifecycle_state: 'wallet_submitted',
      sender_wallet: streamRow().sender_wallet,
      recipient_wallet: streamRow().recipient_wallet
    }
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT pi.*')) return { rows: [{ id: 'intent-1', sender_id: 'sender-1', recipient_id: 'recipient-1', sender_wallet: streamRow().sender_wallet, recipient_wallet: streamRow().recipient_wallet, engagement_id: null, amount_base_units: '10000000', rate_per_second_base_units: '3472', correlation_id: 'correlation-1' }] }
        if (sql.includes('INSERT INTO payment_streams')) return { rows: [provisionedRow] }
        if (sql.includes('UPDATE payment_intents')) return { rows: [{ id: 'intent-1', status: 'chain_pending' }] }
        if (sql.includes('INSERT INTO payment_chain_events')) return { rows: [{ id: 'chain-event-2', finality_status: 'included' }] }
        if (sql.includes('UPDATE payment_streams')) return { rows: [{ id: provisionedRow.id }] }
        if (sql.includes('INSERT INTO financial_audit_events')) return { rows: [{ id: 'audit-2' }] }
        if (sql.includes('INSERT INTO outbox_events')) return { rows: [{ id: 'outbox-2', aggregate_type: 'payment_stream', aggregate_id: provisionedRow.id, event_type: 'payment.chain_event.projected', payload: {}, correlation_id: null, occurred_at: new Date().toISOString(), available_at: new Date().toISOString(), processed_at: null, attempts: 0, last_error: null }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const result = await processVerifiedChainEvent({ client, config, tokenRegistry: createTokenRegistry([token]), intentId: 'intent-1', event: event(), verifierId: '0xoperator' })
    expect(result.stream.id).toBe(provisionedRow.id)
    expect(result.stream.lifecycleState).toBe('chain_included')
    expect(calls.some((call) => call.sql.includes('INSERT INTO payment_streams'))).toBe(true)
    expect(calls.some((call) => call.sql.includes('UPDATE payment_intents'))).toBe(true)
  })

  it('rejects an event that does not match the configured protocol contract', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('SELECT ps.*')) return { rows: [streamRow()] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    await expect(processVerifiedChainEvent({
      client,
      config,
      tokenRegistry: createTokenRegistry([token]),
      streamId: streamRow().id,
      event: { ...event(), protocolContractAddress: '0xc2ba5a41936aaab0ff920446db556efe17fc1c5d' },
      verifierId: '0xoperator'
    })).rejects.toThrow('contract does not match')
  })
})
