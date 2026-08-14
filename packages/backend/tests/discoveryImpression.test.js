import { describe, expect, it } from 'vitest'
import { recordDiscoveryImpressions } from '../lib/discoveryImpressionService.js'

describe('Paytray discovery impressions', () => {
  it('records ranked candidates with query and provenance metadata', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT id FROM users')) return { rows: [{ id: 'client-1' }] }
        return { rows: [] }
      }
    }

    const result = await recordDiscoveryImpressions({
      client,
      walletAddress: '0x1111111111111111111111111111111111111111',
      queryId: 'query-1',
      queryFeatures: { availability: 'today' },
      experts: [
        { id: 'profile-1', matchScore: 93.2, matchExplanation: { version: 1 } },
        { id: 'profile-2', matchScore: 82.1, matchExplanation: { version: 1 } }
      ]
    })

    expect(result).toEqual({ queryId: 'query-1', recorded: 2 })
    expect(calls).toHaveLength(3)
    expect(calls[1].params[3]).toBe(1)
    expect(calls[2].params[3]).toBe(2)
    expect(calls[1].sql).toContain('ON CONFLICT')
    expect(calls[1].params[5]).toBe('{"availability":"today"}')
  })

  it('does not write impressions for an unknown client identity', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('SELECT id FROM users')) return { rows: [] }
        throw new Error('No writes expected')
      }
    }
    await expect(recordDiscoveryImpressions({
      client,
      walletAddress: '0x1111111111111111111111111111111111111111',
      experts: [{ id: 'profile-1', matchScore: 90 }]
    })).resolves.toMatchObject({ recorded: 0 })
  })
})
