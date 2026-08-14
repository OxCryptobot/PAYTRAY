import { describe, expect, it } from 'vitest'
import { getPilotMetrics, normalizeOutcomeInput, recordOutcome, verifyOutcome } from '../lib/outcomeService.js'

describe('Paytray verified outcomes and pilot metrics', () => {
  it('normalizes participant-reported outcomes as unverified evidence', () => {
    const normalized = normalizeOutcomeInput({
      engagementId: 'engagement-1',
      walletAddress: '0x1111111111111111111111111111111111111111',
      eventType: 'meeting_completed',
      evidenceType: 'session',
      evidenceId: 'session-1',
      payload: { durationSeconds: 1800 },
      occurredAt: '2026-08-14T19:00:00.000Z'
    })

    expect(normalized.eventType).toBe('meeting_completed')
    expect(normalized.walletAddress).toBe('0x1111111111111111111111111111111111111111')
  })

  it('returns a replay instead of creating a duplicate outcome event', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT e.id')) return { rows: [{ id: 'engagement-1' }] }
        if (sql.includes('INSERT INTO engagement_outcome_events')) return { rows: [] }
        if (sql.includes('SELECT * FROM engagement_outcome_events')) return { rows: [{ id: 'outcome-1', verification_status: 'unverified' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }

    const result = await recordOutcome({
      client,
      input: {
        engagementId: 'engagement-1',
        walletAddress: '0x1111111111111111111111111111111111111111',
        eventType: 'meeting_completed',
        evidenceType: 'session',
        evidenceId: 'session-1'
      }
    })

    expect(result.idempotentReplay).toBe(true)
    expect(result.outcome.id).toBe('outcome-1')
    expect(calls).toHaveLength(3)
  })

  it('computes pilot conversion rates from durable rows', async () => {
    const client = {
      async query() {
        return { rows: [{ engagements_started: '10', conversations_started: '7', payment_intents: '4', verified_completions: '3', verified_paid_time_events: '5', verified_disputes: '1', verified_repeat_bookings: '2' }] }
      }
    }

    const metrics = await getPilotMetrics({ client })

    expect(metrics.engagementsStarted).toBe(10)
    expect(metrics.matchToConversationRate).toBe(0.7)
    expect(metrics.conversationToPaymentIntentRate).toBe(0.5714)
    expect(metrics.verifiedRepeatBookings).toBe(2)
  })
})

describe('verifier-owned outcomes', () => {
  it('verifies an unverified outcome exactly once and records a deterministic evidence hash', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT * FROM engagement_outcome_events')) return { rows: [{ id: 'outcome-1', verification_status: 'unverified', provenance: {} }] }
        if (sql.includes('UPDATE engagement_outcome_events')) return { rows: [{ id: 'outcome-1', verification_status: 'verified', verification_actor_id: '0xoperator' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const result = await verifyOutcome({
      client,
      outcomeId: 'outcome-1',
      verifierId: '0xoperator',
      verificationEvidence: { chainEventId: 'chain-event-1', finalityStatus: 'finalized' }
    })
    expect(result.idempotentReplay).toBe(false)
    expect(result.outcome.verification_status).toBe('verified')
    expect(calls.at(-1).params[3]).toHaveLength(64)
  })

  it('rejects raw content and does not allow a conflicting terminal transition', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('SELECT * FROM engagement_outcome_events')) return { rows: [{ id: 'outcome-1', verification_status: 'verified' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    await expect(verifyOutcome({ client, outcomeId: 'outcome-1', verifierId: '0xoperator', verificationEvidence: { transcript: 'secret' } })).rejects.toThrow('raw collaboration content')
    await expect(verifyOutcome({ client, outcomeId: 'outcome-1', verifierId: '0xoperator', verificationStatus: 'rejected' })).rejects.toThrow('terminal verification status')
  })
})
