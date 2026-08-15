import { verifyWebhookSignatureWithReplayClaim, WebhookSignatureError } from './webhookSignature.js'

const MAX_REPLAY_KEY_LENGTH = 512

function normalizeReplayKey(value) {
  const key = String(value || '')
  if (!key) throw new WebhookSignatureError('Webhook replay key is required')
  if (key.length > MAX_REPLAY_KEY_LENGTH) throw new WebhookSignatureError('Webhook replay key is too long')
  return key
}

function normalizeExpiry(value) {
  const expiry = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(expiry.getTime())) throw new WebhookSignatureError('Webhook replay expiry is invalid')
  return expiry
}

export async function claimDurableWebhookReplay({ client, replayKey, expiresAt, now = new Date() }) {
  if (!client || typeof client.query !== 'function') throw new WebhookSignatureError('Durable replay store client is required')
  const key = normalizeReplayKey(replayKey)
  const expiry = normalizeExpiry(expiresAt)
  const nowDate = normalizeExpiry(now)
  if (expiry <= nowDate) throw new WebhookSignatureError('Webhook replay expiry is invalid')

  const result = await client.query(
    `WITH claimed AS (
       INSERT INTO webhook_replay_claims (replay_key, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (replay_key) DO UPDATE
         SET expires_at = EXCLUDED.expires_at
         WHERE webhook_replay_claims.expires_at <= $3
       RETURNING replay_key
     ), pruned AS (
       DELETE FROM webhook_replay_claims
       WHERE expires_at <= $3
         AND replay_key NOT IN (SELECT replay_key FROM claimed)
       RETURNING replay_key
     )
     SELECT replay_key FROM claimed`,
    [key, expiry.toISOString(), nowDate.toISOString()]
  )

  return {
    claimed: result.rows.length === 1,
    replayKey: key,
    expiresAt: expiry.toISOString(),
    store: 'postgresql',
    atomic: true,
    settlementAuthority: false,
    settlementMutationPerformed: false
  }
}

export async function verifyWebhookSignatureWithPostgresReplayStore({
  client,
  timestamp,
  body,
  signatureHeader,
  secret,
  toleranceMs = 300000,
  nowMs = Date.now(),
  replayKey
}) {
  return verifyWebhookSignatureWithReplayClaim({
    timestamp,
    body,
    signatureHeader,
    secret,
    toleranceMs,
    nowMs,
    replayKey,
    claimReplay: ({ replayKey: claimKey, expiresAt, nowMs: claimNowMs }) => claimDurableWebhookReplay({
      client,
      replayKey: claimKey,
      expiresAt,
      now: new Date(claimNowMs)
    })
  })
}

export async function verifyWebhookSignatureWithDurableReplayStore({
  verify,
  client,
  replayKey,
  expiresAt,
  now = new Date()
}) {
  if (typeof verify !== 'function') throw new WebhookSignatureError('Signature verification function is required')
  const verified = await verify()
  const claim = await claimDurableWebhookReplay({ client, replayKey, expiresAt, now })
  if (!claim.claimed) throw new WebhookSignatureError('Webhook replay detected')
  return { ...verified, replayProtected: true, replayStore: claim.store, replayClaimAtomic: claim.atomic }
}

export { MAX_REPLAY_KEY_LENGTH }
