import { describe, expect, it, vi } from 'vitest'
import { claimDurableWebhookReplay, verifyWebhookSignatureWithDurableReplayStore, verifyWebhookSignatureWithPostgresReplayStore } from '../lib/durableWebhookReplayStore.js'
import { createWebhookSignatureHeader } from '../lib/webhookSignature.js'

function clientWithRows(rows) {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      return { rows }
    }
  }
}

describe('durable webhook replay store', () => {
  it('claims a new replay key atomically and exposes non-settlement authority', async () => {
    const client = clientWithRows([{ replay_key: 'hook:event-1' }])
    const result = await claimDurableWebhookReplay({
      client,
      replayKey: 'hook:event-1',
      expiresAt: '2026-08-15T00:05:00.000Z',
      now: '2026-08-15T00:00:00.000Z'
    })

    expect(result).toMatchObject({
      claimed: true,
      replayKey: 'hook:event-1',
      store: 'postgresql',
      atomic: true,
      settlementAuthority: false,
      settlementMutationPerformed: false
    })
    expect(client.calls[0].sql).toContain('ON CONFLICT (replay_key) DO UPDATE')
    expect(client.calls[0].sql).toContain('webhook_replay_claims.expires_at <= $3')
  })

  it('reports a duplicate claim without accepting the replay', async () => {
    const client = clientWithRows([])
    const result = await claimDurableWebhookReplay({
      client,
      replayKey: 'hook:event-1',
      expiresAt: '2026-08-15T00:05:00.000Z',
      now: '2026-08-15T00:01:00.000Z'
    })
    expect(result.claimed).toBe(false)
  })

  it('allows a key to be claimed after the prior expiry', async () => {
    const client = clientWithRows([{ replay_key: 'hook:event-1' }])
    const result = await claimDurableWebhookReplay({
      client,
      replayKey: 'hook:event-1',
      expiresAt: '2026-08-15T00:10:00.000Z',
      now: '2026-08-15T00:06:00.000Z'
    })
    expect(result.claimed).toBe(true)
  })

  it('fails closed when durable storage is unavailable', async () => {
    await expect(claimDurableWebhookReplay({ replayKey: 'hook:event-1', expiresAt: Date.now() + 5000 })).rejects.toThrow('client is required')
  })

  it('verifies the exact signed body before claiming through PostgreSQL', async () => {
    const client = clientWithRows([{ replay_key: 'hook:event-1' }])
    const timestamp = 1786752000000
    const body = JSON.stringify({ event: 'payment.updated', eventId: 'event-1' })
    const result = await verifyWebhookSignatureWithPostgresReplayStore({
      client,
      timestamp,
      body,
      signatureHeader: createWebhookSignatureHeader({ timestamp, body, secret: 'test-secret' }),
      secret: 'test-secret',
      nowMs: timestamp,
      replayKey: 'hook:event-1'
    })
    expect(result).toMatchObject({ verified: true, replayProtected: true, replayStore: 'postgresql', replayClaimAtomic: true })
    expect(client.calls).toHaveLength(1)
  })

  it('does not claim when signature verification fails', async () => {
    const client = clientWithRows([{ replay_key: 'hook:event-1' }])
    const verify = vi.fn().mockRejectedValue(new Error('invalid signature'))
    await expect(verifyWebhookSignatureWithDurableReplayStore({
      verify,
      client,
      replayKey: 'hook:event-1',
      expiresAt: '2026-08-15T00:05:00.000Z',
      now: '2026-08-15T00:00:00.000Z'
    })).rejects.toThrow('invalid signature')
    expect(client.calls).toHaveLength(0)
  })
})
