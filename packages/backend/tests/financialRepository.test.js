import { describe, expect, it } from 'vitest'
import { createFinancialRepository, FinancialRepositoryError } from '../lib/payments/financialRepository.js'

describe('Paytray financial repository', () => {
  it('persists payment intents through parameterized base-unit values', async () => {
    const calls = []
    const repository = createFinancialRepository({
      async query(sql, params) {
        calls.push({ sql, params })
        return { rows: [{ id: 'intent-1', status: 'intent_created' }] }
      }
    })

    const intent = await repository.createPaymentIntent({
      senderId: '00000000-0000-4000-8000-000000000001',
      recipientId: '00000000-0000-4000-8000-000000000002',
      intentType: 'create_stream',
      chainId: 84532,
      tokenAddress: '0x1111111111111111111111111111111111111111',
      tokenDecimals: 6,
      amountBaseUnits: '12500000',
      ratePerSecondBaseUnits: '3472',
      idempotencyKey: 'intent-key-1',
      requestHash: 'a'.repeat(64)
    })

    expect(intent.status).toBe('intent_created')
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('INSERT INTO payment_intents')
    expect(calls[0].params).toContain('12500000')
    expect(calls[0].params).not.toContain(12.5)
  })

  it('returns an existing chain event as an idempotent replay', async () => {
    const calls = []
    const existingEvent = { id: 'event-1', transaction_hash: `0x${'a'.repeat(64)}` }
    const repository = createFinancialRepository({
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes('ON CONFLICT')) return { rows: [] }
        return { rows: [existingEvent] }
      }
    })

    const result = await repository.recordChainEvent({
      chainId: 84532,
      protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d',
      transactionHash: `0x${'a'.repeat(64)}`,
      blockNumber: 123,
      blockHash: `0x${'b'.repeat(64)}`,
      logIndex: 0,
      eventName: 'CreateFlowStream',
      payload: { streamId: '42' },
      payloadHash: 'c'.repeat(64),
      finalityStatus: 'included'
    })

    expect(result).toEqual({ event: existingEvent, idempotentReplay: true })
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toContain('ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING')
  })

  it('returns a replay-safe ledger entry for the first write and duplicate chain event', async () => {
    const calls = []
    const entry = { id: 'ledger-1', entry_type: 'stream_accrual' }
    const repository = createFinancialRepository({
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.includes('INSERT INTO ledger_entries')) return { rows: calls.length === 1 ? [entry] : [] }
        if (sql.includes('SELECT * FROM ledger_entries')) return { rows: [entry] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    })
    const input = {
      sourceChainEventId: '00000000-0000-4000-8000-000000000001',
      debitAccountId: '00000000-0000-4000-8000-000000000002',
      creditAccountId: '00000000-0000-4000-8000-000000000003',
      entryType: 'stream_accrual',
      amountBaseUnits: '10',
      chainId: 84532,
      tokenAddress: '0x1111111111111111111111111111111111111111'
    }
    const first = await repository.appendLedgerEntry(input)
    const replay = await repository.appendLedgerEntry(input)
    expect(first).toEqual({ entry, idempotentReplay: false })
    expect(replay).toEqual({ entry, idempotentReplay: true })
    expect(calls[0].sql).toContain('ON CONFLICT DO NOTHING')
  })

  it('rejects non-exact amounts and unproven ledger entries', async () => {
    const repository = createFinancialRepository({ async query() { return { rows: [] } } })

    await expect(repository.createPaymentIntent({
      senderId: 'sender',
      recipientId: 'recipient',
      intentType: 'create_stream',
      chainId: 84532,
      tokenAddress: '0x1111111111111111111111111111111111111111',
      tokenDecimals: 6,
      amountBaseUnits: 12.5,
      idempotencyKey: 'intent-key-1',
      requestHash: 'a'.repeat(64)
    })).rejects.toThrow('amountBaseUnits must be a base-unit integer string')

    await expect(repository.appendLedgerEntry({
      debitAccountId: 'debit',
      creditAccountId: 'credit',
      entryType: 'stream_accrual',
      amountBaseUnits: '10',
      chainId: 84532,
      tokenAddress: '0x1111111111111111111111111111111111111111'
    })).rejects.toThrow(FinancialRepositoryError)
  })
})
