import crypto from 'crypto'
import { ConflictError, NotFoundError, ValidationError } from './errors.js'

function required(value, fieldName) {
  if (value == null || value === '') throw new ValidationError(`${fieldName} is required`)
  return value
}

function wallet(value, fieldName) {
  const normalized = String(required(value, fieldName)).toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new ValidationError(`${fieldName} must be a valid wallet address`)
  return normalized
}

function jsonObject(value, fieldName) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${fieldName} must be an object`)
  return value
}

function derivePaymentStatus({ engagementPaymentStatus, intentStatus, lifecycleState, finalityStatus, ledgerEntryCount }) {
  if (lifecycleState === 'failed' || ['reorged', 'invalid'].includes(finalityStatus)) return 'degraded'
  if (Number(ledgerEntryCount || 0) > 0 && ['ledger_reflected', 'chain_finalized', 'withdrawal_finalized'].includes(lifecycleState)) return 'ledger_reflected'
  if (finalityStatus === 'finalized' || lifecycleState === 'chain_finalized') return 'chain_finalized'
  if (['wallet_submitted', 'chain_pending', 'chain_included'].includes(lifecycleState)) return 'chain_pending'
  if (['wallet_submitted', 'chain_pending'].includes(intentStatus)) return intentStatus
  if (intentStatus === 'failed') return 'degraded'
  return engagementPaymentStatus || intentStatus || 'not_requested'
}

function verifierCursorStatus({ cursorUpdatedAt, paymentStatus, verifierProjection, now = new Date(), maxAgeMs }) {
  if (paymentStatus === 'not_requested') return 'not_required'
  if (!verifierProjection || !cursorUpdatedAt) return 'missing'
  const ageMs = Math.max(0, now.getTime() - new Date(cursorUpdatedAt).getTime())
  return ageMs <= maxAgeMs ? 'fresh' : 'stale'
}

export function mapEngagementPaymentState(row, { now = new Date(), maxVerifierCursorAgeMs = 300000 } = {}) {
  const verifierProjection = row.stream_source === 'verifier'
  const lifecycleState = verifierProjection ? (row.lifecycle_state || null) : null
  const finalityStatus = verifierProjection ? (row.finality_status || 'unverified') : 'unverified'
  const paymentStatus = derivePaymentStatus({
    engagementPaymentStatus: row.engagement_payment_status,
    intentStatus: row.intent_status,
    lifecycleState,
    finalityStatus,
    ledgerEntryCount: row.ledger_entry_count
  })
  const cursorStatus = verifierCursorStatus({
    cursorUpdatedAt: row.verifier_cursor_updated_at,
    paymentStatus,
    verifierProjection,
    now,
    maxAgeMs: maxVerifierCursorAgeMs
  })
  return {
    engagementId: row.id,
    lifecycle_state: lifecycleState,
    finality_status: finalityStatus,
    payment_status: paymentStatus,
    lifecycleState,
    finalityStatus,
    paymentStatus,
    paymentStateMayBeStale: cursorStatus === 'missing' || cursorStatus === 'stale',
    verifierCursorStatus: cursorStatus,
    paymentStateAuthority: verifierProjection ? 'verifier_and_ledger_only' : 'durable_engagement_projection_until_verifier_evidence',
    source: verifierProjection ? 'verifier_payment_projection' : 'durable_engagement_payment_projection',
    streamId: row.stream_id || null,
    intentId: row.intent_id || null,
    chainId: row.chain_id == null ? null : Number(row.chain_id),
    tokenAddress: row.token_address || null,
    lastVerifierUpdateAt: row.lifecycle_updated_at || null,
    ledgerEntryCount: Number(row.ledger_entry_count || 0),
    mutation: 'read_only',
    settlementAuthority: false
  }
}

async function ensureUser(client, walletAddress) {
  const existing = await client.query('SELECT id, wallet_address FROM users WHERE wallet_address = $1', [walletAddress])
  if (existing.rows[0]) return existing.rows[0]
  const created = await client.query(
    `INSERT INTO users (wallet_address, wallet_type, last_login)
     VALUES ($1, 'injected', CURRENT_TIMESTAMP)
     ON CONFLICT (wallet_address) DO UPDATE SET last_login = CURRENT_TIMESTAMP
     RETURNING id, wallet_address`,
    [walletAddress]
  )
  return created.rows[0]
}

export function normalizeEngagementInput({ clientWallet, providerWallet, searchBrief, discoveryContext, rankingExplanation, proposedTerms, matchSessionId = null }) {
  const normalizedClient = wallet(clientWallet, 'clientWallet')
  const normalizedProvider = wallet(providerWallet, 'providerWallet')
  if (normalizedClient === normalizedProvider) throw new ValidationError('Client and provider wallets must be different')
  const brief = String(required(searchBrief, 'searchBrief')).trim()
  if (brief.length < 10 || brief.length > 2000) throw new ValidationError('searchBrief must contain 10-2000 characters')

  return {
    clientWallet: normalizedClient,
    providerWallet: normalizedProvider,
    searchBrief: brief,
    discoveryContext: jsonObject(discoveryContext, 'discoveryContext'),
    rankingExplanation: jsonObject(rankingExplanation, 'rankingExplanation'),
    proposedTerms: jsonObject(proposedTerms, 'proposedTerms'),
    matchSessionId: matchSessionId ? String(matchSessionId) : null
  }
}

export async function createEngagementContext({ client, input }) {
  const normalized = normalizeEngagementInput(input)
  const clientUser = await ensureUser(client, normalized.clientWallet)
  const providerUser = await ensureUser(client, normalized.providerWallet)
  const threadId = `thread-${crypto.randomUUID()}`
  const result = await client.query(
    `INSERT INTO engagements (
      client_id, provider_id, match_session_id, thread_id, status, scope,
      discovery_context, ranking_explanation, proposed_terms,
      collaboration_status, payment_status, context_version
    ) VALUES ($1, $2, $3, $4, 'draft', $5, $6::jsonb, $7::jsonb, $8::jsonb, 'ready', 'not_requested', 1)
    RETURNING *`,
    [
      clientUser.id,
      providerUser.id,
      normalized.matchSessionId,
      threadId,
      normalized.searchBrief,
      JSON.stringify(normalized.discoveryContext),
      JSON.stringify(normalized.rankingExplanation),
      JSON.stringify(normalized.proposedTerms)
    ]
  )

  let discoveryImpressionLinked = false
  const queryId = normalized.discoveryContext.queryId
  const candidateProfileId = normalized.discoveryContext.expertId
  if (queryId && candidateProfileId) {
    const linked = await client.query(
      `UPDATE discovery_impressions
       SET engagement_id = $1,
           selected = true,
           provenance = provenance || $2::jsonb
       WHERE query_id = $3
         AND candidate_profile_id = $4
         AND client_id = $5
       RETURNING id`,
      [result.rows[0].id, JSON.stringify({ selectedAt: new Date().toISOString(), source: 'engagement_created' }), String(queryId), String(candidateProfileId), clientUser.id]
    )
    discoveryImpressionLinked = Boolean(linked.rows[0])
  }

  return { ...result.rows[0], discovery_impression_linked: discoveryImpressionLinked }
}

export async function getEngagementPaymentState({ client, engagementId, walletAddress, maxVerifierCursorAgeMs = 300000, now = new Date() }) {
  const normalizedWallet = wallet(walletAddress, 'walletAddress')
  const result = await client.query(
    `SELECT
       e.id,
       e.payment_status AS engagement_payment_status,
       pi.id AS intent_id,
       pi.status AS intent_status,
       COALESCE(ps.chain_id, pi.chain_id) AS chain_id,
       COALESCE(ps.token_address, pi.token_address) AS token_address,
       ps.id AS stream_id,
       ps.lifecycle_state,
       ps.finality_status,
       ps.lifecycle_updated_at,
       ps.source AS stream_source,
       COALESCE(ledger.ledger_entry_count, 0)::int AS ledger_entry_count,
       cursor.updated_at AS verifier_cursor_updated_at
     FROM engagements e
     JOIN users client ON client.id = e.client_id
     JOIN users provider ON provider.id = e.provider_id
     LEFT JOIN LATERAL (
       SELECT pi.*
       FROM payment_intents pi
       WHERE pi.engagement_id = e.id
       ORDER BY pi.updated_at DESC, pi.created_at DESC
       LIMIT 1
     ) pi ON true
     LEFT JOIN LATERAL (
       SELECT ps.*
       FROM payment_streams ps
       WHERE ps.engagement_id = e.id
       ORDER BY ps.lifecycle_updated_at DESC, ps.created_at DESC
       LIMIT 1
     ) ps ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT le.id) AS ledger_entry_count
       FROM payment_chain_events pce
       JOIN ledger_entries le ON le.source_chain_event_id = pce.id
       WHERE pce.stream_id = ps.id
     ) ledger ON true
     LEFT JOIN LATERAL (
       SELECT pvc.updated_at
       FROM payment_verifier_cursors pvc
       WHERE pvc.chain_id = COALESCE(ps.chain_id, pi.chain_id)
       ORDER BY pvc.updated_at DESC
       LIMIT 1
     ) cursor ON true
     WHERE e.id = $1
       AND (client.wallet_address = $2 OR provider.wallet_address = $2)`,
    [required(engagementId, 'engagementId'), normalizedWallet]
  )
  if (!result.rows[0]) throw new NotFoundError('Engagement')
  return mapEngagementPaymentState(result.rows[0], { now, maxVerifierCursorAgeMs })
}

export async function getEngagementContext({ client, engagementId, walletAddress }) {
  const normalizedWallet = wallet(walletAddress, 'walletAddress')
  const result = await client.query(
    `SELECT e.*, client.wallet_address AS client_wallet, provider.wallet_address AS provider_wallet
     FROM engagements e
     JOIN users client ON client.id = e.client_id
     JOIN users provider ON provider.id = e.provider_id
     WHERE e.id = $1
       AND (client.wallet_address = $2 OR provider.wallet_address = $2)`,
    [required(engagementId, 'engagementId'), normalizedWallet]
  )
  if (!result.rows[0]) throw new NotFoundError('Engagement')
  return result.rows[0]
}

export async function updateCollaborationState({ client, engagementId, walletAddress, status }) {
  const normalizedWallet = wallet(walletAddress, 'walletAddress')
  if (!['active', 'degraded', 'completed'].includes(status)) throw new ValidationError('Invalid collaboration status')
  const result = await client.query(
    `UPDATE engagements e
     SET collaboration_status = $1::varchar,
         status = CASE WHEN $1::varchar = 'completed' THEN 'completed' ELSE 'active' END,
         updated_at = CURRENT_TIMESTAMP
     FROM users client_user, users provider_user
     WHERE e.id = $2::uuid
       AND e.client_id = client_user.id
       AND e.provider_id = provider_user.id
       AND (client_user.wallet_address = $3::varchar OR provider_user.wallet_address = $3::varchar)
     RETURNING e.*`,
    [status, required(engagementId, 'engagementId'), normalizedWallet]
  )
  if (!result.rows[0]) throw new NotFoundError('Engagement')
  return result.rows[0]
}

export async function attachPaymentIntentToEngagement({ client, engagementId, walletAddress, paymentIntentId }) {
  const normalizedWallet = wallet(walletAddress, 'walletAddress')
  const result = await client.query(
    `UPDATE engagements e
     SET payment_status = 'intent_created', updated_at = CURRENT_TIMESTAMP
     FROM users client_user
     WHERE e.id = $1
       AND e.client_id = client_user.id
       AND client_user.wallet_address = $2
       AND EXISTS (SELECT 1 FROM payment_intents pi WHERE pi.id = $3 AND pi.engagement_id = e.id)
     RETURNING e.*`,
    [required(engagementId, 'engagementId'), normalizedWallet, required(paymentIntentId, 'paymentIntentId')]
  )
  if (!result.rows[0]) throw new ConflictError('Payment intent is not attached to this client engagement')
  return result.rows[0]
}
