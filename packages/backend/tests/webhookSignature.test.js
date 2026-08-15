import { describe, expect, it } from 'vitest'
import {
  WebhookReplayGuard,
  createWebhookSignature,
  createWebhookSignatureHeader,
  verifyWebhookSignature
} from '../lib/webhookSignature.js'

const secret = 'test-webhook-secret'
const body = JSON.stringify({ event: 'payment.chain_event_projected', payload: { eventId: 'outbox-1:hook-1', projected: true } })
const nowMs = 1_700_000_000_000
const timestamp = String(nowMs)

describe('webhook signature security', () => {
  it('creates and verifies the exact timestamp/body HMAC digest', () => {
    const digest = createWebhookSignature({ timestamp, body, secret })
    const header = createWebhookSignatureHeader({ timestamp, body, secret })
    expect(header).toBe(`v1=${digest}`)
    expect(verifyWebhookSignature({ timestamp, body, signatureHeader: header, secret, nowMs, toleranceMs: 300000 })).toMatchObject({ verified: true, timestampMs: nowMs, skewMs: 0, replayProtected: false })
  })

  it('rejects a changed body, malformed signature, and stale or future timestamp', () => {
    const header = createWebhookSignatureHeader({ timestamp, body, secret })
    expect(() => verifyWebhookSignature({ timestamp, body: `${body} `, signatureHeader: header, secret, nowMs, toleranceMs: 300000 })).toThrow('verification failed')
    expect(() => verifyWebhookSignature({ timestamp, body, signatureHeader: 'v1=not-a-digest', secret, nowMs, toleranceMs: 300000 })).toThrow('signature header is invalid')
    expect(() => verifyWebhookSignature({ timestamp: String(nowMs - 300001), body, signatureHeader: createWebhookSignatureHeader({ timestamp: String(nowMs - 300001), body, secret }), secret, nowMs, toleranceMs: 300000 })).toThrow('outside the allowed skew window')
    expect(() => verifyWebhookSignature({ timestamp: String(nowMs + 300001), body, signatureHeader: createWebhookSignatureHeader({ timestamp: String(nowMs + 300001), body, secret }), secret, nowMs, toleranceMs: 300000 })).toThrow('outside the allowed skew window')
  })

  it('rejects a replay of a valid event within the timestamp window', () => {
    const replayGuard = new WebhookReplayGuard({ now: () => nowMs, maxEntries: 10 })
    const header = createWebhookSignatureHeader({ timestamp, body, secret })
    const first = verifyWebhookSignature({ timestamp, body, signatureHeader: header, secret, nowMs, toleranceMs: 300000, replayGuard, replayKey: 'outbox-1:hook-1' })
    expect(first).toMatchObject({ verified: true, replayProtected: true })
    expect(() => verifyWebhookSignature({ timestamp, body, signatureHeader: header, secret, nowMs, toleranceMs: 300000, replayGuard, replayKey: 'outbox-1:hook-1' })).toThrow('replay detected')
  })

  it('allows the same replay key after the guard entry expires', () => {
    let clock = nowMs
    const replayGuard = new WebhookReplayGuard({ now: () => clock, maxEntries: 10 })
    const header = createWebhookSignatureHeader({ timestamp, body, secret })
    verifyWebhookSignature({ timestamp, body, signatureHeader: header, secret, nowMs, toleranceMs: 300000, replayGuard, replayKey: 'outbox-1:hook-1' })
    clock = nowMs + 300001
    const freshTimestamp = String(clock)
    const freshHeader = createWebhookSignatureHeader({ timestamp: freshTimestamp, body, secret })
    expect(verifyWebhookSignature({ timestamp: freshTimestamp, body, signatureHeader: freshHeader, secret, nowMs: clock, toleranceMs: 300000, replayGuard, replayKey: 'outbox-1:hook-1' })).toMatchObject({ verified: true, replayProtected: true })
  })
})
