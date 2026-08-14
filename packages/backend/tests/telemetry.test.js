import { describe, expect, it } from 'vitest'
import { ingestTelemetryEvent, normalizeTelemetryEvent, TelemetryValidationError } from '../lib/telemetryService.js'

describe('Paytray production telemetry', () => {
  const baseEvent = {
    eventId: 'telemetry-1',
    eventType: 'discovery_impression',
    occurredAt: '2026-08-14T19:00:00.000Z',
    actorScope: 'authenticated_client',
    entityType: 'expert_profile',
    entityId: 'profile-1',
    schemaVersion: '1',
    source: 'discovery-v2',
    privacyClass: 'derived_non_content',
    payload: { queryId: 'query-1', rankPosition: 1, baselineScore: 91.4 },
    provenance: { rankingVersion: 'weighted-explainable-v1' }
  }

  it('normalizes a privacy-safe telemetry event and derives a stable payload hash', () => {
    const normalized = normalizeTelemetryEvent(baseEvent, new Date('2026-08-14T19:00:02.000Z'))
    expect(normalized.payloadHash).toHaveLength(64)
    expect(normalized.receivedAt).toBe('2026-08-14T19:00:02.000Z')
    expect(normalized.payload.queryId).toBe('query-1')
  })

  it('rejects raw collaboration content and future-dated producer events', () => {
    expect(() => normalizeTelemetryEvent({ ...baseEvent, payload: { transcript: 'private' } }, new Date('2026-08-14T19:00:02.000Z'))).toThrow(TelemetryValidationError)
    expect(() => normalizeTelemetryEvent({ ...baseEvent, occurredAt: '2026-08-14T20:00:00.000Z' }, new Date('2026-08-14T19:00:02.000Z'))).toThrow('after receivedAt')
  })

  it('persists the first event and returns the existing row on duplicate replay', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('INSERT INTO production_telemetry_events')) return { rows: calls.length === 1 ? [{ id: 'row-1', event_id: 'telemetry-1' }] : [] }
        if (sql.includes('SELECT * FROM production_telemetry_events')) return { rows: [{ id: 'row-1', event_id: 'telemetry-1' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const first = await ingestTelemetryEvent({ client, event: baseEvent, receivedAt: new Date('2026-08-14T19:00:02.000Z') })
    const replay = await ingestTelemetryEvent({ client, event: baseEvent, receivedAt: new Date('2026-08-14T19:00:03.000Z') })
    expect(first.idempotentReplay).toBe(false)
    expect(first.ingestionLagMs).toBe(2000)
    expect(replay.idempotentReplay).toBe(true)
    expect(replay.event.id).toBe('row-1')
  })
})
