import { describe, expect, it } from 'vitest'
import { purgeExpiredIdempotencyRecords } from '../lib/idempotencyCleanupService.js'

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

describe('idempotency cleanup service', () => {
  it('deletes only expired records with a bounded skip-locked batch', async () => {
    const client = clientWithRows([{ id: 'expired-1' }, { id: 'expired-2' }])
    const result = await purgeExpiredIdempotencyRecords({
      client,
      now: '2026-08-15T00:00:00.000Z',
      batchSize: 2
    })

    expect(result).toMatchObject({
      deletedCount: 2,
      batchSize: 2,
      hasMore: true,
      authority: 'idempotency_housekeeping',
      settlementAuthority: false,
      settlementMutationPerformed: false
    })
    expect(client.calls[0].sql).toContain('expires_at <= $1')
    expect(client.calls[0].sql).toContain('FOR UPDATE SKIP LOCKED')
    expect(client.calls[0].sql).toContain('LIMIT $2')
    expect(client.calls[0].params).toEqual(['2026-08-15T00:00:00.000Z', 2])
  })

  it('reports no more work when the deleted batch is smaller than the limit', async () => {
    const client = clientWithRows([{ id: 'expired-1' }])
    const result = await purgeExpiredIdempotencyRecords({ client, batchSize: 10 })
    expect(result.deletedCount).toBe(1)
    expect(result.hasMore).toBe(false)
  })

  it('rejects invalid batch sizes and timestamps before database access', async () => {
    const client = clientWithRows([])
    await expect(purgeExpiredIdempotencyRecords({ client, batchSize: 0 })).rejects.toThrow('batchSize')
    await expect(purgeExpiredIdempotencyRecords({ client, now: 'not-a-date' })).rejects.toThrow('now')
    expect(client.calls).toHaveLength(0)
  })
})
