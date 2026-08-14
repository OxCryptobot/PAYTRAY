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
