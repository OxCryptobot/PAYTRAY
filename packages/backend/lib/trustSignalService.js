import { NotFoundError, ValidationError } from './errors.js'

const DERIVATION_RULES = Object.freeze({
  meeting_completed: [
    { subject: 'client', signalType: 'verified_meeting_completion', polarity: 'positive', score: 1 },
    { subject: 'provider', signalType: 'verified_meeting_completion', polarity: 'positive', score: 2 }
  ],
  paid_minutes_delivered: [
    { subject: 'provider', signalType: 'verified_paid_time_delivery', polarity: 'positive', score: 2 }
  ],
  repeat_booking: [
    { subject: 'client', signalType: 'verified_repeat_booking', polarity: 'positive', score: 1 },
    { subject: 'provider', signalType: 'verified_repeat_booking', polarity: 'positive', score: 2 }
  ],
  dispute_opened: [
    { subject: 'client', signalType: 'verified_dispute_evidence', polarity: 'neutral', score: 0 },
    { subject: 'provider', signalType: 'verified_dispute_evidence', polarity: 'neutral', score: 0 }
  ]
})

const MAX_LIMIT = 100

function normalizeLimit(value = 50) {
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  return limit
}

function normalizeOffset(value = 0) {
  const offset = Number(value)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new ValidationError('offset must be an integer between 0 and 100000')
  return offset
}

function verifiedOutcomeSource(outcome) {
  if (!outcome || outcome.verification_status !== 'verified') return false
  const provenance = outcome.provenance && typeof outcome.provenance === 'object' ? outcome.provenance : {}
  return provenance.verificationSource === 'verifier' && Boolean(outcome.verification_evidence_hash)
}

function subjectWallet(row, subject) {
  return subject === 'client' ? row.client_wallet_address : row.provider_wallet_address
}

export async function deriveVerifiedTrustSignals({ client, outcome }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  if (!outcome?.id || !verifiedOutcomeSource(outcome)) {
    return { derived: false, reason: 'outcome_is_not_verifier_verified', signals: [], authority: 'verified_outcome_evidence', mutation: 'read_only' }
  }
  const rules = DERIVATION_RULES[outcome.event_type] || []
  if (rules.length === 0) {
    return { derived: false, reason: 'outcome_type_has_no_trust_rule', signals: [], authority: 'verified_outcome_evidence', mutation: 'read_only' }
  }

  const engagement = await client.query(
    `SELECT e.id, e.client_id, e.provider_id,
            client_user.wallet_address AS client_wallet_address,
            provider_user.wallet_address AS provider_wallet_address
     FROM engagements e
     JOIN users client_user ON client_user.id = e.client_id
     JOIN users provider_user ON provider_user.id = e.provider_id
     WHERE e.id = $1`,
    [outcome.engagement_id]
  )
  if (!engagement.rows[0]) throw new NotFoundError('Engagement')
  const row = engagement.rows[0]
  const signals = []
  for (const rule of rules) {
    const subjectUserId = rule.subject === 'client' ? row.client_id : row.provider_id
    const inserted = await client.query(
      `INSERT INTO verified_trust_signals (
         subject_user_id, subject_wallet_address, engagement_id, outcome_id,
         signal_type, polarity, score, eligible_for_ranking, evidence_hash, provenance
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8, $9::jsonb)
       ON CONFLICT (subject_user_id, outcome_id, signal_type) DO NOTHING
       RETURNING *`,
      [
        subjectUserId,
        subjectWallet(row, rule.subject),
        row.id,
        outcome.id,
        rule.signalType,
        rule.polarity,
        rule.score,
        outcome.verification_evidence_hash,
        JSON.stringify({
          source: 'verified_outcome',
          verificationSource: 'verifier',
          outcomeId: outcome.id,
          outcomeType: outcome.event_type,
          evidenceType: outcome.evidence_type,
          evidenceId: outcome.evidence_id,
          eligibleForRanking: false,
          authority: 'verified_outcome_evidence',
          mutation: 'read_only'
        })
      ]
    )
    if (inserted.rows[0]) {
      signals.push({ signal: inserted.rows[0], idempotentReplay: false })
      continue
    }
    const existing = await client.query(
      `SELECT * FROM verified_trust_signals
       WHERE subject_user_id = $1 AND outcome_id = $2 AND signal_type = $3`,
      [subjectUserId, outcome.id, rule.signalType]
    )
    signals.push({ signal: existing.rows[0] || null, idempotentReplay: true })
  }

  return {
    derived: true,
    outcomeId: outcome.id,
    signals,
    authority: 'verified_outcome_evidence',
    eligibleForRanking: false,
    promotionStatus: 'shadow_only',
    settlementAuthority: false,
    mutation: 'read_only'
  }
}

export async function listVerifiedTrustSignals({ client, subjectWalletAddress = null, signalType = null, limit = 50, offset = 0 }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const normalizedLimit = normalizeLimit(limit)
  const normalizedOffset = normalizeOffset(offset)
  const wallet = subjectWalletAddress == null || subjectWalletAddress === '' ? null : String(subjectWalletAddress).toLowerCase()
  const type = signalType == null || signalType === '' ? null : String(signalType)
  const result = await client.query(
    `SELECT id, subject_user_id, subject_wallet_address, engagement_id, outcome_id,
            signal_type, polarity, score, eligible_for_ranking, evidence_hash,
            provenance, created_at
     FROM verified_trust_signals
     WHERE ($1::varchar IS NULL OR LOWER(subject_wallet_address) = $1)
       AND ($2::varchar IS NULL OR signal_type = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [wallet, type, normalizedLimit, normalizedOffset]
  )
  return {
    status: 'ok',
    authority: 'verified_outcome_evidence',
    mutation: 'read_only',
    settlementAuthority: false,
    eligibleForRanking: false,
    promotionStatus: 'shadow_only',
    signals: result.rows,
    pagination: { limit: normalizedLimit, offset: normalizedOffset, count: result.rows.length }
  }
}

export { DERIVATION_RULES }
