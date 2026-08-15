import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { hashStructuredInput } from './aiEvaluation.js'
import { deriveVerifiedTrustSignals } from './trustSignalService.js'

const OUTCOME_TYPES = new Set(['meeting_completed', 'paid_minutes_delivered', 'no_show', 'dispute_opened', 'repeat_booking'])
const EVIDENCE_TYPES = new Set(['session', 'payment_chain_event', 'ledger_entry', 'dispute_record', 'engagement'])

function required(value, fieldName) {
  if (value == null || value === '') throw new ValidationError(`${fieldName} is required`)
  return value
}

function wallet(value) {
  const normalized = String(required(value, 'walletAddress')).toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new ValidationError('walletAddress must be a valid wallet address')
  return normalized
}

export function normalizeOutcomeInput({ engagementId, walletAddress, eventType, evidenceType, evidenceId = null, payload = {}, occurredAt }) {
  if (!OUTCOME_TYPES.has(eventType)) throw new ValidationError('Unsupported outcome event type')
  if (!EVIDENCE_TYPES.has(evidenceType)) throw new ValidationError('Unsupported outcome evidence type')
  if (typeof payload !== 'object' || Array.isArray(payload)) throw new ValidationError('Outcome payload must be an object')
  const date = occurredAt ? new Date(occurredAt) : new Date()
  if (Number.isNaN(date.getTime())) throw new ValidationError('occurredAt must be a valid timestamp')
  return {
    engagementId: required(engagementId, 'engagementId'),
    walletAddress: wallet(walletAddress),
    eventType,
    evidenceType,
    evidenceId: evidenceId == null ? null : String(evidenceId),
    payload,
    occurredAt: date.toISOString()
  }
}

export async function recordOutcome({ client, input }) {
  const normalized = normalizeOutcomeInput(input)
  const access = await client.query(
    `SELECT e.id
     FROM engagements e
     JOIN users client_user ON client_user.id = e.client_id
     JOIN users provider_user ON provider_user.id = e.provider_id
     WHERE e.id = $1
       AND (client_user.wallet_address = $2 OR provider_user.wallet_address = $2)`,
    [normalized.engagementId, normalized.walletAddress]
  )
  if (!access.rows[0]) throw new NotFoundError('Engagement')

  const inserted = await client.query(
    `INSERT INTO engagement_outcome_events (
      engagement_id, event_type, actor_type, actor_id, evidence_type,
      evidence_id, payload, verification_status, provenance, occurred_at
    ) VALUES ($1, $2, 'client', $3, $4, $5, $6::jsonb, 'unverified', $7::jsonb, $8)
    ON CONFLICT (engagement_id, event_type, evidence_type, evidence_id) DO NOTHING
    RETURNING *`,
    [
      normalized.engagementId,
      normalized.eventType,
      normalized.walletAddress,
      normalized.evidenceType,
      normalized.evidenceId,
      JSON.stringify(normalized.payload),
      JSON.stringify({ source: 'participant_report', walletAddress: normalized.walletAddress }),
      normalized.occurredAt
    ]
  )
  if (inserted.rows[0]) return { outcome: inserted.rows[0], idempotentReplay: false }

  const existing = await client.query(
    `SELECT * FROM engagement_outcome_events
     WHERE engagement_id = $1 AND event_type = $2 AND evidence_type = $3
       AND evidence_id IS NOT DISTINCT FROM $4`,
    [normalized.engagementId, normalized.eventType, normalized.evidenceType, normalized.evidenceId]
  )
  if (!existing.rows[0]) throw new ConflictError('Outcome event replay could not be resolved')
  return { outcome: existing.rows[0], idempotentReplay: true }
}

export async function verifyOutcome({ client, outcomeId, verifierId, verificationStatus = 'verified', verificationEvidence = {} }) {
  if (!outcomeId) throw new ValidationError('outcomeId is required')
  if (!verifierId) throw new ValidationError('verifierId is required')
  if (!['verified', 'rejected'].includes(verificationStatus)) throw new ValidationError('verificationStatus must be verified or rejected')
  if (!verificationEvidence || typeof verificationEvidence !== 'object' || Array.isArray(verificationEvidence)) {
    throw new ValidationError('verificationEvidence must be an object')
  }
  if (Object.keys(verificationEvidence).some((key) => ['message', 'body', 'transcript', 'recording', 'audio', 'video', 'privateKey', 'signature'].includes(key))) {
    throw new ValidationError('verificationEvidence cannot contain raw collaboration content or secrets')
  }

  const existing = await client.query('SELECT * FROM engagement_outcome_events WHERE id = $1 FOR UPDATE', [outcomeId])
  if (!existing.rows[0]) throw new NotFoundError('Outcome')
  const current = existing.rows[0]
  if (current.verification_status !== 'unverified') {
    if (current.verification_status === verificationStatus) {
      const trustSignals = verificationStatus === 'verified'
        ? await deriveVerifiedTrustSignals({ client, outcome: current })
        : { derived: false, reason: 'outcome_rejected', signals: [], authority: 'verified_outcome_evidence', mutation: 'read_only' }
      return { outcome: current, idempotentReplay: true, trustSignals }
    }
    throw new ConflictError('Outcome has already reached a terminal verification status')
  }

  const verifiedAt = new Date().toISOString()
  const evidenceHash = hashStructuredInput({ outcomeId, verificationStatus, verificationEvidence })
  const updated = await client.query(
    `UPDATE engagement_outcome_events
     SET verification_status = $1,
         verification_actor_id = $2,
         verified_at = $3,
         verification_evidence_hash = $4,
         provenance = provenance || $5::jsonb
     WHERE id = $6 AND verification_status = 'unverified'
     RETURNING *`,
    [verificationStatus, String(verifierId), verifiedAt, evidenceHash, JSON.stringify({ verificationSource: 'verifier', verifierId: String(verifierId), verifiedAt, verificationEvidenceHash: evidenceHash }), outcomeId]
  )
  if (!updated.rows[0]) throw new ConflictError('Outcome verification raced with another verifier')
  const trustSignals = verificationStatus === 'verified'
    ? await deriveVerifiedTrustSignals({ client, outcome: updated.rows[0] })
    : { derived: false, reason: 'outcome_rejected', signals: [], authority: 'verified_outcome_evidence', mutation: 'read_only' }
  return { outcome: updated.rows[0], idempotentReplay: false, trustSignals }
}

export async function getPilotMetrics({ client, from = null, to = null }) {
  const result = await client.query(`
    SELECT
      COUNT(DISTINCT e.id) FILTER (WHERE e.status IN ('active', 'completed', 'cancelled', 'disputed')) AS engagements_started,
      COUNT(DISTINCT e.id) FILTER (WHERE e.collaboration_status IN ('active', 'completed')) AS conversations_started,
      COUNT(DISTINCT e.id) FILTER (WHERE e.payment_status <> 'not_requested') AS payment_intents,
      COUNT(*) FILTER (WHERE o.event_type = 'meeting_completed' AND o.verification_status = 'verified') AS verified_completions,
      COUNT(*) FILTER (WHERE o.event_type = 'paid_minutes_delivered' AND o.verification_status = 'verified') AS verified_paid_time_events,
      COUNT(*) FILTER (WHERE o.event_type = 'dispute_opened' AND o.verification_status = 'verified') AS verified_disputes,
      COUNT(*) FILTER (WHERE o.event_type = 'repeat_booking' AND o.verification_status = 'verified') AS verified_repeat_bookings
    FROM engagements e
    LEFT JOIN engagement_outcome_events o ON o.engagement_id = e.id
    WHERE ($1::timestamp IS NULL OR e.created_at >= $1)
      AND ($2::timestamp IS NULL OR e.created_at < $2)
  `, [from, to])

  const row = result.rows[0]
  const engagementsStarted = Number(row.engagements_started || 0)
  return {
    asOf: new Date().toISOString(),
    source: 'durable_engagement_and_outcome_events',
    engagementsStarted,
    conversationsStarted: Number(row.conversations_started || 0),
    paymentIntents: Number(row.payment_intents || 0),
    verifiedCompletions: Number(row.verified_completions || 0),
    verifiedPaidTimeEvents: Number(row.verified_paid_time_events || 0),
    verifiedDisputes: Number(row.verified_disputes || 0),
    verifiedRepeatBookings: Number(row.verified_repeat_bookings || 0),
    matchToConversationRate: engagementsStarted ? Number((Number(row.conversations_started || 0) / engagementsStarted).toFixed(4)) : null,
    conversationToPaymentIntentRate: Number(row.conversations_started || 0) ? Number((Number(row.payment_intents || 0) / Number(row.conversations_started || 0)).toFixed(4)) : null
  }
}

export { OUTCOME_TYPES, EVIDENCE_TYPES }
