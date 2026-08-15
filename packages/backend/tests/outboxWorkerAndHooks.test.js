import { describe, expect, it, vi } from 'vitest'
import { listExtensionHooks, registerExtensionHook } from '../lib/extensionHookService.js'
import { createOutboxWorker } from '../lib/outboxWorkerService.js'

function hookClient() {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (sql.includes('INSERT INTO extension_hooks')) {
        return {
          rows: [{
            id: 'hook-1',
            owner_wallet: '0xowner',
            api_version: 'v2',
            contract_version: '2026-08-15',
            event: 'payment.chain_event_projected',
            callback_url: 'https://example.com/hook',
            projections: ['identifiers'],
            replay_window_seconds: 300,
            delivery: { signed: true },
            created_at: '2026-08-15T00:00:00.000Z'
          }]
        }
      }
      return { rows: [{ id: 'hook-1', owner_wallet: '0xowner', api_version: 'v2', contract_version: '2026-08-15', event: 'payment.chain_event_projected', callback_url: 'https://example.com/hook', projections: ['identifiers'], replay_window_seconds: 300, delivery: { signed: true }, created_at: '2026-08-15T00:00:00.000Z' }] }
    }
  }
}

describe('production outbox worker and durable hook service', () => {
  it('runs bounded idle polling and preserves delivery authority boundaries', async () => {
    const tick = vi.fn()
      .mockResolvedValueOnce({ status: 'ok', candidates: 0, settlementAuthority: false })
      .mockResolvedValueOnce({ status: 'ok', candidates: 0, settlementAuthority: false })
    const worker = createOutboxWorker({ tick, intervalMs: 1000, maxIdlePolls: 2, sleep: async () => {} })
    const result = await worker.run()
    expect(tick).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('idle_limit_reached')
    expect(result.lastResult.workerIdlePolls).toBe(2)
    expect(result.lastResult.settlementAuthority).toBe(false)
  })

  it('prevents concurrent worker ticks', async () => {
    let release
    const tick = vi.fn().mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const worker = createOutboxWorker({ tick, intervalMs: 1000 })
    const first = worker.runOnce()
    const second = await worker.runOnce()
    expect(second.status).toBe('skipped_concurrent_tick')
    release({ status: 'ok', candidates: 1 })
    await first
  })

  it('persists v2 hooks and loads their public delivery fields', async () => {
    const client = hookClient()
    const hook = await registerExtensionHook({
      client,
      ownerWallet: '0xOWNER',
      hook: {
        apiVersion: 'v2',
        contractVersion: '2026-08-15',
        event: 'payment.chain_event_projected',
        callbackUrl: 'https://example.com/hook',
        projections: ['identifiers'],
        replayWindowSeconds: 300,
        delivery: { signed: true, retryable: true }
      }
    })
    expect(hook).toMatchObject({ id: 'hook-1', ownerWallet: '0xowner', apiVersion: 'v2', event: 'payment.chain_event_projected' })
    const listed = await listExtensionHooks({ client, ownerWallet: '0xOWNER' })
    expect(listed).toHaveLength(1)
    expect(listed[0].callbackUrl).toBe('https://example.com/hook')
    expect(client.calls.some(({ sql }) => sql.includes('active = true'))).toBe(true)
  })
})
