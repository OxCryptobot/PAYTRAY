import { describe, expect, it } from 'vitest'
import { buildVerifierOperationsEvidence } from '../lib/verifierOperationsEvidence.js'

const config = {
  isProd: true,
  payments: {
    settlementChainId: 84532,
    protocol: 'sablier-flow-v3',
    protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d',
    rpcUrl: 'https://rpc.example',
    finalityConfirmations: 10,
    verifierCursorMaxAgeMs: 300000,
    reconciliationLagThresholdMs: 300000
  }
}

function clientFor({ cursorUpdatedAt, finalizedWithoutLedger = false } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM payment_verifier_cursors')) {
        return { rows: [{ chain_id: 84532, last_scanned_block: '100', updated_at: cursorUpdatedAt }] }
      }
      if (sql.includes('FROM payment_chain_events') && sql.includes('GROUP BY finality_status')) {
        return { rows: [{ finality_status: 'finalized', count: 1, latest_observed_at: cursorUpdatedAt, latest_finalized_at: cursorUpdatedAt }] }
      }
      if (sql.includes('stream_id IS NULL')) return { rows: [{ count: '0' }] }
      if (sql.includes('FROM payment_streams ps')) {
        return { rows: finalizedWithoutLedger ? [{ id: 'stream-1', lifecycle_state: 'chain_finalized', finality_status: 'finalized', protocol_stream_id: '42', last_transaction_hash: '0xabc', chain_event_count: 1, ledger_entry_count: 0, last_chain_event_at: cursorUpdatedAt, last_finalized_at: cursorUpdatedAt, last_ledger_entry_at: null }] : [] }
      }
      if (sql.includes('FROM payment_intents pi')) return { rows: [] }
      if (sql.includes('FROM financial_audit_events')) return { rows: [{ action: 'payment_chain_event_projected', count: '1', latest_at: cursorUpdatedAt }] }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }
}

describe('verifier operations evidence', () => {
  it('reports ready when the cursor is fresh, reconciliation is clean, and evidence is linked', async () => {
    const now = new Date('2026-08-15T02:00:00.000Z')
    const result = await buildVerifierOperationsEvidence({
      client: clientFor({ cursorUpdatedAt: '2026-08-15T01:59:00.000Z' }),
      config,
      now
    })
    expect(result).toMatchObject({
      status: 'ready',
      authority: 'verifier_operations_evidence',
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      verifier: { verifierStatus: { status: 'fresh', ready: true } },
      reconciliation: { status: 'ok' }
    })
  })

  it('blocks when reconciliation finds finalized value without a ledger entry', async () => {
    const now = new Date('2026-08-15T02:00:00.000Z')
    const result = await buildVerifierOperationsEvidence({
      client: clientFor({ cursorUpdatedAt: '2026-08-15T01:59:00.000Z', finalizedWithoutLedger: true }),
      config,
      now
    })
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('reconciliation status is attention')
    expect(result.reconciliation.issues).toContainEqual({ type: 'finalized_without_ledger_entry', streamId: 'stream-1' })
  })
})
