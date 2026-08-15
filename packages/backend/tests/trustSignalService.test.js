import { describe, expect, it } from 'vitest'
import { deriveVerifiedTrustSignals, listVerifiedTrustSignals } from '../lib/trustSignalService.js'

function createClient({ insertRows = [], existingRows = [] } = {}) {
  const calls = []
  let insertIndex = 0
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params })
      if (sql.includes('FROM engagements e')) {
        return {
          rows: [{
            id: 'engagement-1',
            client_id: 'client-1',
            provider_id: 'provider-1',
            client_wallet_address: '0xclient',
            provider_wallet_address: '0xprovider'
          }]
        }
      }
      if (sql.includes('INSERT INTO verified_trust_signals')) {
        return { rows: insertRows[insertIndex++] || [] }
      }
      if (sql.includes('FROM verified_trust_signals')) return { rows: existingRows }
      return { rows: [] }
    }
  }
}

const verifiedOutcome = {
  id: 'outcome-1',
  engagement_id: 'engagement-1',
  event_type: 'meeting_completed',
  evidence_type: 'session',
  evidence_id: 'session-1',
  verification_status: 'verified',
  verification_evidence_hash: 'a'.repeat(64),
  provenance: { verificationSource: 'verifier' }
}

describe('verified trust signal service', () => {
  it('derives positive client/provider signals from a verified meeting', async () => {
    const client = createClient({
      insertRows: [[{ id: 'signal-client', signal_type: 'verified_meeting_completion' }], [{ id: 'signal-provider', signal_type: 'verified_meeting_completion' }]]
    })
    const result = await deriveVerifiedTrustSignals({ client, outcome: verifiedOutcome })
    expect(result.derived).toBe(true)
    expect(result.signals).toHaveLength(2)
    expect(result.signals[0].idempotentReplay).toBe(false)
    expect(result.eligibleForRanking).toBe(false)
    expect(result.promotionStatus).toBe('shadow_only')
    expect(result.settlementAuthority).toBe(false)
  })

  it('does not derive from an unverified or non-verifier outcome', async () => {
    const client = createClient()
    const result = await deriveVerifiedTrustSignals({
      client,
      outcome: { ...verifiedOutcome, verification_status: 'unverified' }
    })
    expect(result).toMatchObject({ derived: false, reason: 'outcome_is_not_verifier_verified' })
    expect(client.calls).toHaveLength(0)
  })

  it('derives neutral dispute evidence without a negative trust score', async () => {
    const client = createClient({ insertRows: [[{ id: 'dispute-client', polarity: 'neutral', score: 0 }], [{ id: 'dispute-provider', polarity: 'neutral', score: 0 }]] })
    const result = await deriveVerifiedTrustSignals({
      client,
      outcome: { ...verifiedOutcome, event_type: 'dispute_opened' }
    })
    expect(result.signals).toHaveLength(2)
    expect(result.signals.every(({ signal }) => signal.polarity === 'neutral' && signal.score === 0)).toBe(true)
  })

  it('returns idempotent replay records for an existing derived signal', async () => {
    const client = createClient({
      insertRows: [[], []],
      existingRows: [{ id: 'existing-signal', signal_type: 'verified_meeting_completion' }]
    })
    const result = await deriveVerifiedTrustSignals({ client, outcome: verifiedOutcome })
    expect(result.signals).toHaveLength(2)
    expect(result.signals.every(({ idempotentReplay }) => idempotentReplay)).toBe(true)
  })

  it('lists signals as read-only and permanently ineligible for ranking', async () => {
    const client = createClient()
    client.query = async (sql, params) => {
      client.calls.push({ sql, params })
      return { rows: [{ id: 'signal-1', subject_wallet_address: '0xprovider', eligible_for_ranking: false }] }
    }
    const result = await listVerifiedTrustSignals({ client, subjectWalletAddress: '0xProvider', limit: 10, offset: 0 })
    expect(result).toMatchObject({ status: 'ok', mutation: 'read_only', settlementAuthority: false, eligibleForRanking: false, promotionStatus: 'shadow_only' })
    expect(result.signals[0].eligible_for_ranking).toBe(false)
  })
})
