import { describe, expect, it } from 'vitest'
import { createEngagementContext, getEngagementPaymentState, mapEngagementPaymentState, normalizeEngagementInput } from '../lib/engagementService.js'

describe('Paytray engagement context', () => {
  const clientWallet = '0x1111111111111111111111111111111111111111'
  const providerWallet = '0x2222222222222222222222222222222222222222'

  it('preserves discovery context and time-stream terms in a normalized engagement input', () => {
    const normalized = normalizeEngagementInput({
      clientWallet,
      providerWallet,
      searchBrief: 'Need a resilient ERC-20 streaming adapter for a testnet pilot.',
      discoveryContext: { expertId: 'expert-1', matchedFilters: ['streaming', 'verified'] },
      rankingExplanation: { version: 1, components: { skillMatch: 0.9 } },
      proposedTerms: { chainId: 84532, tokenAddress: '0x3333333333333333333333333333333333333333', ratePerSecondBaseUnits: '3472' },
      matchSessionId: 'match-1'
    })

    expect(normalized.clientWallet).toBe(clientWallet)
    expect(normalized.discoveryContext.matchedFilters).toContain('verified')
    expect(normalized.proposedTerms.ratePerSecondBaseUnits).toBe('3472')
  })

  it('creates a durable engagement with a thread handoff and payment/collaboration separation', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT id, wallet_address')) {
          return { rows: [{ id: params[0] === clientWallet ? 'client-id' : 'provider-id', wallet_address: params[0] }] }
        }
        if (sql.includes('INSERT INTO engagements')) {
          return { rows: [{ id: 'engagement-1', thread_id: params[3], collaboration_status: 'ready', payment_status: 'not_requested' }] }
        }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }

    const engagement = await createEngagementContext({
      client,
      input: {
        clientWallet,
        providerWallet,
        searchBrief: 'Need a resilient ERC-20 streaming adapter for a testnet pilot.',
        discoveryContext: { expertId: 'expert-1' },
        rankingExplanation: { version: 1 },
        proposedTerms: { chainId: 84532 }
      }
    })

    expect(engagement.id).toBe('engagement-1')
    expect(engagement.collaboration_status).toBe('ready')
    expect(engagement.payment_status).toBe('not_requested')
    expect(engagement.thread_id).toMatch(/^thread-/)
    expect(calls.some((call) => call.sql.includes('INSERT INTO engagements'))).toBe(true)
  })

  it('returns verifier-owned finalized and ledger-reflected payment state', async () => {
    const client = {
      async query(sql) {
        expect(sql).toContain('FROM engagements e')
        return { rows: [{
          id: 'engagement-1',
          engagement_payment_status: 'intent_created',
          intent_id: 'intent-1',
          intent_status: 'chain_pending',
          chain_id: 84532,
          token_address: '0x3333333333333333333333333333333333333333',
          stream_id: 'stream-1',
          stream_source: 'verifier',
          lifecycle_state: 'chain_finalized',
          finality_status: 'finalized',
          lifecycle_updated_at: '2026-08-15T03:00:00.000Z',
          ledger_entry_count: 1,
          verifier_cursor_updated_at: '2026-08-15T03:04:00.000Z'
        }] }
      }
    }
    const state = await getEngagementPaymentState({
      client,
      engagementId: 'engagement-1',
      walletAddress: clientWallet,
      maxVerifierCursorAgeMs: 300000,
      now: new Date('2026-08-15T03:05:00.000Z')
    })
    expect(state).toMatchObject({
      payment_status: 'ledger_reflected',
      lifecycle_state: 'chain_finalized',
      finality_status: 'finalized',
      paymentStateMayBeStale: false,
      verifierCursorStatus: 'fresh',
      paymentStateAuthority: 'verifier_and_ledger_only',
      mutation: 'read_only',
      settlementAuthority: false
    })
  })

  it('marks payment state stale when verifier evidence is unavailable or old', () => {
    const state = mapEngagementPaymentState({
      id: 'engagement-2',
      engagement_payment_status: 'intent_created',
      intent_status: 'intent_created',
      lifecycle_state: null,
      finality_status: 'unverified',
      verifier_cursor_updated_at: null,
      ledger_entry_count: 0
    }, { now: new Date('2026-08-15T03:05:00.000Z'), maxVerifierCursorAgeMs: 300000 })
    expect(state).toMatchObject({ payment_status: 'intent_created', paymentStateMayBeStale: true, verifierCursorStatus: 'missing' })
  })

  it('does not claim verifier staleness when no payment has been requested', () => {
    const state = mapEngagementPaymentState({
      id: 'engagement-3',
      engagement_payment_status: 'not_requested',
      intent_status: null,
      lifecycle_state: null,
      finality_status: 'unverified',
      verifier_cursor_updated_at: null,
      ledger_entry_count: 0
    })
    expect(state).toMatchObject({ payment_status: 'not_requested', paymentStateMayBeStale: false, verifierCursorStatus: 'not_required' })
  })

  it('rejects identical participant wallets and short briefs', () => {
    expect(() => normalizeEngagementInput({
      clientWallet,
      providerWallet: clientWallet,
      searchBrief: 'This is long enough to pass the brief length check.'
    })).toThrow('must be different')

    expect(() => normalizeEngagementInput({
      clientWallet,
      providerWallet,
      searchBrief: 'too short'
    })).toThrow('10-2000 characters')
  })
})
