import { describe, expect, it } from 'vitest'
import { buildDurableReconciliationReport } from '../lib/payments/reconciliationService.js'

function client({ issue = false } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM payment_streams')) return {
        rows: [{
          id: 'stream-1', lifecycle_state: issue ? 'chain_included' : 'chain_finalized', finality_status: issue ? 'finalized' : 'finalized',
          protocol_stream_id: '42', transaction_hash: `0x${'a'.repeat(64)}`, chain_event_count: '1', ledger_entry_count: issue ? '0' : '1', last_chain_event_at: '2026-08-14T20:00:00.000Z'
        }]
      }
      if (sql.includes('FROM payment_intents')) return {
        rows: [{ id: 'intent-1', status: 'chain_pending', transaction_hash: issue ? `0x${'b'.repeat(64)}` : null, stream_id: 'stream-1', matching_chain_events: issue ? '0' : '1' }]
      }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }
}

describe('durable reconciliation service', () => {
  it('reports a clean verifier-to-ledger state', async () => {
    const report = await buildDurableReconciliationReport({ client: client() })
    expect(report.status).toBe('ok')
    expect(report.summary.issues).toBe(0)
    expect(report.authority).toBe('read_only_reconciliation_report')
  })

  it('surfaces financial evidence gaps without mutating state', async () => {
    const report = await buildDurableReconciliationReport({ client: client({ issue: true }) })
    expect(report.status).toBe('attention')
    expect(report.issues.map((issue) => issue.type)).toEqual(expect.arrayContaining(['lifecycle_finality_mismatch', 'finalized_without_ledger_entry', 'intent_transaction_without_chain_event']))
  })
})
