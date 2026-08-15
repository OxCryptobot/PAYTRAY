import { describe, expect, it } from 'vitest'
import { processDurableOutbox } from '../lib/outboxProcessorService.js'
import { createWebhookSignature } from '../lib/webhookSignature.js'

const row = {
  id: '11111111-1111-4111-8111-111111111111',
  aggregate_type: 'payment_stream',
  aggregate_id: '22222222-2222-4222-8222-222222222222',
  event_type: 'payment.chain_event_projected',
  payload: { streamId: 'stream-1', projected: true, message: 'must not be delivered as raw content' },
  correlation_id: '33333333-3333-4333-8333-333333333333',
  occurred_at: '2026-08-15T00:00:00.000Z',
  available_at: '2026-08-15T00:00:00.000Z',
  processed_at: null,
  attempts: 0,
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

function hook(event = 'payment.chain_event_projected') {
  return {
    id: 'hook-1',
    apiVersion: 'v2',
    contractVersion: '2026-08-15',
    event,
    callbackUrl: 'https://example.com/hook',
    projections: ['identifiers', 'lifecycle'],
    ownerWallet: '0x1111111111111111111111111111111111111111'
  }
}

describe('durable outbox processor', () => {
  it('plans a dry run without claiming or mutating events and strips raw content from the projected envelope', async () => {
    const client = clientFor([{ rows: [row] }])
    const result = await processDurableOutbox({ client, hooks: [hook()], dryRun: true, signingSecret: 'test-secret' })
    expect(result).toMatchObject({ status: 'ok', dryRun: true, claimed: 0, candidates: 1, processed: 1, failed: 0, mutation: 'read_only', settlementAuthority: false })
    expect(result.results[0]).toMatchObject({ status: 'would_deliver', matchedHooks: 1, payloadSha256: expect.any(String) })
    expect(client.queries).toHaveLength(1)
    expect(client.queries[0].sql).toContain('SELECT *')
  })

  it('delivers a claimed event with a signature and marks it processed', async () => {
    const client = clientFor([
      { rows: [row] },
      { rows: [{ id: row.id, processed_at: '2026-08-15T00:01:00.000Z' }] }
    ])
    let request
    const result = await processDurableOutbox({
      client,
      hooks: [hook()],
      dryRun: false,
      signingSecret: 'test-secret',
      fetchImpl: async (url, options) => {
        request = { url, options }
        return { ok: true, status: 200 }
      }
    })
    expect(result).toMatchObject({ status: 'ok', dryRun: false, claimed: 1, processed: 1, failed: 0, mutation: 'outbox_delivery_only', settlementAuthority: false })
    expect(result.results[0].status).toBe('processed')
    expect(request.url).toBe('https://example.com/hook')
    expect(request.options.headers['x-paytray-signature']).toMatch(/^v1=/)
    const expectedDigest = createWebhookSignature({
      timestamp: request.options.headers['x-paytray-timestamp'],
      body: request.options.body,
      secret: 'test-secret'
    })
    expect(request.options.headers['x-paytray-signature']).toBe(`v1=${expectedDigest}`)
    expect(request.options.body).toContain('stream-1')
    expect(request.options.body).not.toContain('must not be delivered as raw content')
    expect(client.queries[1].sql).toContain('SET processed_at')
  })

  it('records bounded retry failure when a callback rejects the delivery', async () => {
    const client = clientFor([
      { rows: [{ ...row, attempts: 1 }] },
      { rows: [{ ...row, attempts: 1, last_error: 'remote 503' }] }
    ])
    const result = await processDurableOutbox({
      client,
      hooks: [hook()],
      dryRun: false,
      retryBaseDelayMs: 1000,
      maxAttempts: 3,
      fetchImpl: async () => { throw new Error('remote 503') }
    })
    expect(result).toMatchObject({ status: 'attention', claimed: 1, processed: 0, failed: 1, mutation: 'outbox_delivery_only' })
    expect(result.results[0]).toMatchObject({ status: 'failed', lastError: 'remote 503', settlementAuthority: false })
    expect(client.queries[1].sql).toContain('SET last_error')
  })

  it('marks events with no subscribers as processed only in non-dry-run mode', async () => {
    const client = clientFor([
      { rows: [row] },
      { rows: [{ id: row.id, processed_at: '2026-08-15T00:01:00.000Z' }] }
    ])
    const result = await processDurableOutbox({ client, hooks: [], dryRun: false })
    expect(result).toMatchObject({ status: 'ok', processed: 1, skipped: 1 })
    expect(result.results[0].status).toBe('processed_no_subscriber')
  })
})
