import { describe, expect, it } from 'vitest'
import { getVerifierObservability } from '../lib/verifierObservability.js'

describe('verifier observability', () => {
  it('reports cursor freshness, finality distribution, and unlinked evidence read-only', async () => {
    const now = new Date('2026-08-14T21:00:00.000Z')
    const client = {
      async query(sql) {
        if (sql.includes('payment_verifier_cursors')) return { rows: [{ chain_id: 84532, last_scanned_block: '123', updated_at: '2026-08-14T20:59:00.000Z' }] }
        if (sql.includes('GROUP BY finality_status')) return { rows: [{ finality_status: 'finalized', count: 2, latest_observed_at: '2026-08-14T20:59:30.000Z', latest_finalized_at: '2026-08-14T20:59:45.000Z' }] }
        if (sql.includes('stream_id IS NULL')) return { rows: [{ count: 1 }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const report = await getVerifierObservability({
      client,
      config: { payments: { settlementChainId: 84532, protocol: 'sablier-flow-v3', protocolContractAddress: '0xabc', rpcUrl: 'https://rpc.example', finalityConfirmations: 10 } },
      now
    })
    expect(report).toMatchObject({ chainId: 84532, configured: true, cursorAgeMs: 60000, unlinkedEvidenceCount: 1, authority: 'verifier_owned', mutation: 'read_only' })
    expect(report.finality.finalized.count).toBe(2)
  })
})


describe('financial summary', () => {
  it('summarizes durable financial state without mutating it', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('FROM payment_intents')) return { rows: [{ status: 'chain_pending', count: 2 }] }
        if (sql.includes('FROM payment_streams GROUP')) return { rows: [{ status: 'active', count: 1 }] }
        if (sql.includes('GROUP BY finality_status')) return { rows: [{ finality_status: 'finalized', count: 3 }] }
        if (sql.includes('FROM ledger_entries')) return { rows: [{ count: 4 }] }
        if (sql.includes('NOT EXISTS')) return { rows: [{ count: 1 }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const { getFinancialSummary } = await import('../lib/verifierObservability.js')
    const summary = await getFinancialSummary({ client, config: { payments: { settlementChainId: 84532 } } })
    expect(summary).toEqual({
      chainId: 84532,
      paymentIntentsByStatus: { chain_pending: 2 },
      durableStreamsByLifecycle: { active: 1 },
      chainEventsByFinality: { finalized: 3 },
      ledgerEntryCount: 4,
      unreconciledStreamCount: 1,
      authority: 'verifier_owned',
      mutation: 'read_only'
    })
  })
})
