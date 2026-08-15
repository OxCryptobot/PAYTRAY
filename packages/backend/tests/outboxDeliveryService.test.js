import { describe, expect, it } from 'vitest'
import {
  claimOutboxEvents,
  enqueueOutboxEvent,
  getOutboxHealth,
  listOutboxEvents,
  markOutboxProcessed,
  recordOutboxFailure
} from '../lib/outboxDeliveryService.js'

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  aggregate_type: 'payment_stream',
  aggregate_id: '22222222-2222-4222-8222-222222222222',
  event_type: 'payment.chain_event.projected',
  payload: { streamId: 'stream-1', projected: true },
  correlation_id: '33333333-3333-4333-8333-333333333333',
  occurred_at: '2026-08-15T00:00:00.000Z',
  available_at: '2026-08-15T00:00:00.000Z',
  processed_at: null,
  attempts: 1,
  last_error: null
}

function clientFor(responses = []) {
  let index = 0
  return {
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params })
      const response = responses[index++]
      if (response instanceof Error) throw response
      return response || { rows: [] }
    }
  }
}

describe('durable outbox delivery service', () => {
  it('enqueues an event with a content-free payload fingerprint', async () => {
    const client = clientFor([{ rows: [row] }])
    const event = await enqueueOutboxEvent({
      client,
      aggregateType: 'payment_stream',
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload
    })
    expect(event).toMatchObject({ id: row.id, eventType: row.event_type, status: 'pending', payloadKeys: ['projected', 'streamId'] })
    expect(event.payloadSha256).toHaveLength(64)
  })

  it('claims due events and records processed or failed outcomes', async () => {
    const client = clientFor([{ rows: [row] }, { rows: [{ id: row.id, processed_at: '2026-08-15T00:01:00.000Z' }] }, { rows: [{ ...row, last_error: 'remote 503' }] }])
    const claimed = await claimOutboxEvents({ client, limit: 5, leaseMs: 1000, maxAttempts: 3 })
    expect(claimed[0]).toMatchObject({ id: row.id, attempts: 1 })
    expect(await markOutboxProcessed({ client, eventId: row.id })).toMatchObject({ id: row.id })
    expect(await recordOutboxFailure({ client, eventId: row.id, error: new Error('remote 503'), maxAttempts: 3 })).toMatchObject({ id: row.id, lastError: 'remote 503', status: 'failed' })
  })

  it('reports dead-letter attention and supports filtered event inspection', async () => {
    const healthClient = clientFor([{ rows: [{ total: '4', processed: '2', pending: '0', leased: '0', failed: '1', dead: '1', due: '1', oldest_pending_at: null, latest_processed_at: '2026-08-15T00:02:00.000Z' }] }])
    const health = await getOutboxHealth({ client: healthClient, maxAttempts: 3 })
    expect(health).toMatchObject({ status: 'attention', total: 4, processed: 2, dead: 1, retryableCount: 2, authority: 'durable_outbox_delivery_health', mutation: 'read_only' })

    const listClient = clientFor([{ rows: [row] }])
    const events = await listOutboxEvents({ client: listClient, limit: 10, offset: 0, status: 'failed', maxAttempts: 3 })
    expect(events[0]).toMatchObject({ id: row.id, eventType: row.event_type })
  })
})
