import { describe, expect, it } from 'vitest'
import { processDurableOutbox } from '../lib/outboxProcessorService.js'
import { WebhookReplayGuard, verifyWebhookSignature } from '../lib/webhookSignature.js'

const secret = 'load-test-webhook-secret'
const eventCount = 100

function buildRow(index) {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    aggregate_type: 'payment_stream',
    aggregate_id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    event_type: 'payment.chain_event_projected',
    payload: { streamId: `stream-${index}`, projected: true },
    correlation_id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    occurred_at: '2026-08-15T00:00:00.000Z',
    available_at: '2026-08-15T00:00:00.000Z',
    processed_at: null,
    attempts: 0,
    last_error: null
  }
}

function clientFor(rows) {
  let queryCount = 0
  return {
    async query(sql, params) {
      queryCount += 1
      if (sql.includes('WITH picked')) return { rows }
      if (sql.includes('SET processed_at')) return { rows: [{ id: params[0], processed_at: '2026-08-15T00:01:00.000Z' }] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
    get queryCount() {
      return queryCount
    }
  }
}

describe('webhook delivery and replay protection under simulated load', () => {
  it(`delivers ${eventCount} isolated events, verifies each exact signature, and rejects duplicate replays`, async () => {
    const rows = Array.from({ length: eventCount }, (_, index) => buildRow(index + 1))
    const client = clientFor(rows)
    const captured = []
    const hook = {
      id: 'hook-load-1',
      apiVersion: 'v2',
      contractVersion: '2026-08-15',
      event: 'payment.chain_event_projected',
      callbackUrl: 'https://8.8.8.8/paytray-load-test',
      projections: ['identifiers', 'lifecycle', 'provenance'],
      ownerWallet: '0x1111111111111111111111111111111111111111'
    }

    const result = await processDurableOutbox({
      client,
      hooks: [hook],
      dryRun: false,
      limit: eventCount,
      maxAttempts: 3,
      signingSecret: secret,
      fetchImpl: async (url, options) => {
        captured.push({ url, options })
        return { ok: true, status: 200 }
      }
    })

    expect(result).toMatchObject({ status: 'ok', candidates: eventCount, claimed: eventCount, processed: eventCount, failed: 0, settlementAuthority: false })
    expect(captured).toHaveLength(eventCount)
    expect(client.queryCount).toBe(eventCount + 1)

    const replayGuard = new WebhookReplayGuard({ maxEntries: eventCount + 10 })
    const verified = captured.map(({ options }) => {
      const payload = JSON.parse(options.body).payload
      return verifyWebhookSignature({
        timestamp: options.headers['x-paytray-timestamp'],
        body: options.body,
        signatureHeader: options.headers['x-paytray-signature'],
        secret,
        replayGuard,
        replayKey: payload.eventId
      })
    })
    expect(verified.every((item) => item.verified && item.replayProtected)).toBe(true)

    const replayFailures = captured.map(({ options }) => {
      const payload = JSON.parse(options.body).payload
      try {
        verifyWebhookSignature({
          timestamp: options.headers['x-paytray-timestamp'],
          body: options.body,
          signatureHeader: options.headers['x-paytray-signature'],
          secret,
          replayGuard,
          replayKey: payload.eventId
        })
        return false
      } catch (error) {
        return error.message === 'Webhook replay detected'
      }
    })
    expect(replayFailures).toHaveLength(eventCount)
    expect(replayFailures.every(Boolean)).toBe(true)
  })
})
