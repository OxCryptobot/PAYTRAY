import { describe, expect, it } from 'vitest'
import { claimWebhookInbox, getWebhookInboxHealth, markWebhookInboxProcessed, markWebhookInboxRetryable, quarantineWebhookInbox } from '../lib/webhookInboxService.js'

function createClient({ insertRows = [], selectRows = [], updateRows = [], healthRows = [] } = {}) {
  const calls = []
  let insertIndex = 0
  let selectIndex = 0
  let updateIndex = 0
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (sql.includes('INSERT INTO webhook_inbox')) return { rows: insertRows[insertIndex++] || [] }
      if (sql.includes('SELECT * FROM webhook_inbox')) return { rows: selectRows[selectIndex++] || [] }
      if (sql.includes('UPDATE webhook_inbox')) return { rows: updateRows[updateIndex++] || [] }
      if (sql.includes('FROM webhook_inbox')) return { rows: healthRows }
      return { rows: [] }
    }
  }
}

const baseInput = {
  replayKey: 'v1:hook-1:event-1',
  eventId: 'event-1',
  hookId: 'hook-1',
  eventType: 'ai.shadow_review_recorded',
  body: '{"event":"ai.shadow_review_recorded"}',
  payload: { runId: 'run-1', applied: false },
  now: '2026-08-15T00:00:00.000Z',
  leaseMs: 120000
}

describe('webhook inbox service', () => {
  it('atomically claims a new signed event and does not establish settlement', async () => {
    const client = createClient({ insertRows: [[{ replay_key: baseInput.replayKey, status: 'claimed', attempts: 1 }]] })
    const result = await claimWebhookInbox({ client, ...baseInput })
    expect(result).toMatchObject({ claimed: true, duplicate: false, mutation: 'inbox_claim_only', settlementAuthority: false })
    expect(client.calls[0].sql).toContain('ON CONFLICT (replay_key) DO NOTHING')
  })

  it('returns processed duplicate without re-running business work', async () => {
    const client = createClient({
      insertRows: [[]],
      selectRows: [[{ body_sha256: 'cf5e3a20150d8541f3227f3c68efcba4c44c74a97749661db1f2b880c0b00baa', event_type: baseInput.eventType, status: 'processed' }]]
    })
    const result = await claimWebhookInbox({ client, ...baseInput })
    expect(result).toMatchObject({ claimed: false, duplicate: true, reason: 'processed', mutation: 'read_only' })
  })

  it('reclaims an expired lease atomically', async () => {
    const client = createClient({
      insertRows: [[]],
      selectRows: [[{ body_sha256: 'cf5e3a20150d8541f3227f3c68efcba4c44c74a97749661db1f2b880c0b00baa', event_type: baseInput.eventType, status: 'retryable', next_attempt_at: '2026-08-14T23:00:00.000Z', lease_until: null }]],
      updateRows: [[{ replay_key: baseInput.replayKey, status: 'claimed', attempts: 2 }]]
    })
    const result = await claimWebhookInbox({ client, ...baseInput })
    expect(result).toMatchObject({ claimed: true, duplicate: true, mutation: 'inbox_reclaim' })
  })

  it('records bounded retry and quarantines after the attempt limit', async () => {
    const client = createClient({ updateRows: [[{ replay_key: baseInput.replayKey, status: 'quarantined', attempts: 5 }]] })
    const result = await markWebhookInboxRetryable({ client, replayKey: baseInput.replayKey, error: 'consumer failed', now: baseInput.now, maxAttempts: 5 })
    expect(result).toMatchObject({ retryable: false, quarantined: true, mutation: 'inbox_failure_recorded', settlementAuthority: false })
    expect(client.calls[0].sql).toContain("status = CASE WHEN attempts >= $3 THEN 'quarantined' ELSE 'retryable' END")
  })

  it('marks claimed work processed and supports explicit quarantine', async () => {
    const client = createClient({ updateRows: [[{ replay_key: baseInput.replayKey, status: 'processed' }], [{ replay_key: baseInput.replayKey, status: 'quarantined' }]] })
    const processed = await markWebhookInboxProcessed({ client, replayKey: baseInput.replayKey, now: baseInput.now })
    const quarantined = await quarantineWebhookInbox({ client, replayKey: baseInput.replayKey, reason: 'schema violation', now: baseInput.now })
    expect(processed.processed).toBe(true)
    expect(quarantined.quarantined).toBe(true)
  })

  it('rejects raw collaboration content or secrets in the durable payload', async () => {
    const client = createClient()
    await expect(claimWebhookInbox({ client, ...baseInput, payload: { body: 'raw transcript' } })).rejects.toThrow('forbidden')
    expect(client.calls).toHaveLength(0)
  })

  it('reports operational health without financial authority', async () => {
    const client = createClient({ healthRows: [{ total: '5', claimed: '1', processed: '3', retryable: '0', quarantined: '1', due: '0' }] })
    const result = await getWebhookInboxHealth({ client })
    expect(result).toMatchObject({ status: 'attention', total: 5, processed: 3, quarantined: 1, mutation: 'read_only', settlementAuthority: false })
  })
})
