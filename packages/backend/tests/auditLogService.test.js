import { describe, expect, it } from 'vitest'
import { listFinancialAuditEvents } from '../lib/auditLogService.js'

describe('financial audit log service', () => {
  it('lists filtered events with pagination and recursively redacts sensitive metadata', async () => {
    const calls = []
    const client = {
      async query(sql, params) {
        calls.push({ sql, params })
        if (sql.startsWith('SELECT COUNT')) return { rows: [{ count: '2' }] }
        return {
          rows: [{
            id: 'event-1',
            actor_type: 'verifier',
            actor_id: 'worker-1',
            action: 'payment_chain_event_projected',
            entity_type: 'payment_stream',
            entity_id: 'stream-1',
            correlation_id: 'correlation-1',
            metadata: {
              safe: 'value',
              privateKey: 'must-not-leak',
              nested: { authorization: 'bearer secret', count: 1 }
            },
            created_at: '2026-08-15T02:00:00.000Z'
          }]
        }
      }
    }

    const result = await listFinancialAuditEvents({
      client,
      limit: '10',
      offset: '1',
      actorType: 'verifier',
      action: 'payment_chain_event_projected'
    })

    expect(result).toMatchObject({
      status: 'ok',
      authority: 'financial_audit_events',
      mutation: 'read_only',
      pagination: { limit: 10, offset: 1, total: 2, hasMore: false },
      filters: { actorType: 'verifier', action: 'payment_chain_event_projected' }
    })
    expect(result.events[0]).toMatchObject({
      id: 'event-1',
      actorType: 'verifier',
      entityType: 'payment_stream',
      metadata: {
        safe: 'value',
        privateKey: '[REDACTED]',
        nested: { authorization: '[REDACTED]', count: 1 }
      }
    })
    expect(calls[0].params).toEqual(['verifier', 'payment_chain_event_projected'])
    expect(calls[1].params).toEqual(['verifier', 'payment_chain_event_projected', 10, 1])
  })

  it('rejects invalid pagination and does not query the database', async () => {
    const client = { query: async () => ({ rows: [] }) }
    await expect(listFinancialAuditEvents({ client, limit: '101' })).rejects.toThrow('limit must be an integer between 1 and 100')
    await expect(listFinancialAuditEvents({ client, offset: '-1' })).rejects.toThrow('offset must be an integer between 0 and 100000')
  })
})
