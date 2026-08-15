import { createHash } from 'node:crypto'
import { ConflictError, ValidationError } from './errors.js'

const MAX_REPLAY_KEY_LENGTH = 512
const MAX_EVENT_TYPE_LENGTH = 128
const MAX_ERROR_LENGTH = 500
const FORBIDDEN_PAYLOAD_KEYS = new Set(['message', 'body', 'transcript', 'recording', 'audio', 'video', 'privateKey', 'signature'])

function requiredString(value, field, maximum) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new ValidationError(`${field} is required`)
  if (normalized.length > maximum) throw new ValidationError(`${field} is too long`)
  return normalized
}

function normalizeDate(value, field) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} must be a valid timestamp`)
  return date
}

function normalizePositiveInteger(value, field, maximum) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new ValidationError(`${field} must be an integer between 1 and ${maximum}`)
  return number
}

function normalizePayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ValidationError('payload must be an object')
  if (Object.keys(payload).some((key) => FORBIDDEN_PAYLOAD_KEYS.has(key))) throw new ValidationError('payload contains forbidden raw-content or secret keys')
  return payload
}

function payloadHash(body) {
  if (typeof body !== 'string') throw new ValidationError('body must be the exact raw request body string')
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

function leaseUntil(now, leaseMs) {
  return new Date(now.getTime() + leaseMs)
}

export async function claimWebhookInbox({
  client,
  replayKey,
  eventId = null,
  hookId = null,
  eventType,
  body,
  payload = {},
  now = new Date(),
  leaseMs = 120000
}) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const key = requiredString(replayKey, 'replayKey', MAX_REPLAY_KEY_LENGTH)
  const type = requiredString(eventType, 'eventType', MAX_EVENT_TYPE_LENGTH)
  const normalizedPayload = normalizePayload(payload)
  const normalizedNow = normalizeDate(now, 'now')
  const boundedLeaseMs = normalizePositiveInteger(leaseMs, 'leaseMs', 86400000)
  const hash = payloadHash(body)
  const inserted = await client.query(
    `INSERT INTO webhook_inbox (
       replay_key, event_id, hook_id, event_type, body_sha256, payload,
       status, attempts, lease_until, next_attempt_at, received_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'claimed', 1, $7, $8, $8, $8)
     ON CONFLICT (replay_key) DO NOTHING
     RETURNING *`,
    [key, eventId == null ? null : String(eventId), hookId == null ? null : String(hookId), type, hash, JSON.stringify(normalizedPayload), leaseUntil(normalizedNow, boundedLeaseMs).toISOString(), normalizedNow.toISOString()]
  )
  if (inserted.rows[0]) {
    return { claimed: true, duplicate: false, state: inserted.rows[0], authority: 'durable_webhook_inbox', mutation: 'inbox_claim_only', settlementAuthority: false }
  }

  const existing = await client.query('SELECT * FROM webhook_inbox WHERE replay_key = $1 FOR UPDATE', [key])
  const current = existing.rows[0]
  if (!current) return { claimed: false, duplicate: true, reason: 'claim_raced', authority: 'durable_webhook_inbox', mutation: 'read_only', settlementAuthority: false }
  if (current.body_sha256 !== hash || current.event_type !== type) throw new ConflictError('Webhook replay key conflicts with a different signed payload')
  if (current.status === 'processed' || current.status === 'quarantined') {
    return { claimed: false, duplicate: true, reason: current.status, state: current, authority: 'durable_webhook_inbox', mutation: 'read_only', settlementAuthority: false }
  }
  const leaseActive = current.status === 'claimed' && current.lease_until && new Date(current.lease_until).getTime() > normalizedNow.getTime()
  const retryNotDue = current.status === 'retryable' && current.next_attempt_at && new Date(current.next_attempt_at).getTime() > normalizedNow.getTime()
  if (leaseActive || retryNotDue) {
    return { claimed: false, duplicate: true, reason: leaseActive ? 'lease_active' : 'retry_not_due', state: current, authority: 'durable_webhook_inbox', mutation: 'read_only', settlementAuthority: false }
  }

  const reclaimed = await client.query(
    `UPDATE webhook_inbox
     SET status = 'claimed',
         attempts = attempts + 1,
         lease_until = $2,
         next_attempt_at = $3,
         last_error = NULL,
         updated_at = $3
     WHERE replay_key = $1
       AND status IN ('claimed', 'retryable')
       AND (lease_until IS NULL OR lease_until <= $3)
       AND next_attempt_at <= $3
     RETURNING *`,
    [key, leaseUntil(normalizedNow, boundedLeaseMs).toISOString(), normalizedNow.toISOString()]
  )
  if (!reclaimed.rows[0]) return { claimed: false, duplicate: true, reason: 'claim_raced', authority: 'durable_webhook_inbox', mutation: 'read_only', settlementAuthority: false }
  return { claimed: true, duplicate: true, state: reclaimed.rows[0], authority: 'durable_webhook_inbox', mutation: 'inbox_reclaim', settlementAuthority: false }
}

export async function markWebhookInboxProcessed({ client, replayKey, now = new Date() }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const key = requiredString(replayKey, 'replayKey', MAX_REPLAY_KEY_LENGTH)
  const normalizedNow = normalizeDate(now, 'now')
  const result = await client.query(
    `UPDATE webhook_inbox
     SET status = 'processed', processed_at = $2, lease_until = NULL, last_error = NULL, updated_at = $2
     WHERE replay_key = $1 AND status = 'claimed'
     RETURNING *`,
    [key, normalizedNow.toISOString()]
  )
  return { processed: Boolean(result.rows[0]), state: result.rows[0] || null, authority: 'durable_webhook_inbox', mutation: 'inbox_processed', settlementAuthority: false }
}

export async function markWebhookInboxRetryable({ client, replayKey, error, now = new Date(), retryBaseDelayMs = 1000, maxAttempts = 5 }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const key = requiredString(replayKey, 'replayKey', MAX_REPLAY_KEY_LENGTH)
  const normalizedNow = normalizeDate(now, 'now')
  const boundedDelay = normalizePositiveInteger(retryBaseDelayMs, 'retryBaseDelayMs', 86400000)
  const boundedMaxAttempts = normalizePositiveInteger(maxAttempts, 'maxAttempts', 100)
  const message = String(error?.message || error || 'webhook inbox processing failed').slice(0, MAX_ERROR_LENGTH)
  const result = await client.query(
    `UPDATE webhook_inbox
     SET status = CASE WHEN attempts >= $3 THEN 'quarantined' ELSE 'retryable' END,
         lease_until = NULL,
         next_attempt_at = CASE WHEN attempts >= $3 THEN $2 ELSE $2 + (($4::bigint * (2 ^ GREATEST(attempts - 1, 0))) * INTERVAL '1 millisecond') END,
         last_error = $5,
         updated_at = $2
     WHERE replay_key = $1 AND status = 'claimed'
     RETURNING *`,
    [key, normalizedNow.toISOString(), boundedMaxAttempts, boundedDelay, message]
  )
  return { retryable: result.rows[0]?.status === 'retryable', quarantined: result.rows[0]?.status === 'quarantined', state: result.rows[0] || null, authority: 'durable_webhook_inbox', mutation: 'inbox_failure_recorded', settlementAuthority: false }
}

export async function quarantineWebhookInbox({ client, replayKey, reason, now = new Date() }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const key = requiredString(replayKey, 'replayKey', MAX_REPLAY_KEY_LENGTH)
  const normalizedNow = normalizeDate(now, 'now')
  const result = await client.query(
    `UPDATE webhook_inbox
     SET status = 'quarantined', lease_until = NULL, last_error = $2, updated_at = $3
     WHERE replay_key = $1 AND status IN ('claimed', 'retryable')
     RETURNING *`,
    [key, String(reason || 'webhook quarantined').slice(0, MAX_ERROR_LENGTH), normalizedNow.toISOString()]
  )
  return { quarantined: Boolean(result.rows[0]), state: result.rows[0] || null, authority: 'durable_webhook_inbox', mutation: 'inbox_quarantined', settlementAuthority: false }
}

export async function getWebhookInboxHealth({ client }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const result = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'claimed')::int AS claimed,
      COUNT(*) FILTER (WHERE status = 'processed')::int AS processed,
      COUNT(*) FILTER (WHERE status = 'retryable')::int AS retryable,
      COUNT(*) FILTER (WHERE status = 'quarantined')::int AS quarantined,
      COUNT(*) FILTER (WHERE status IN ('claimed', 'retryable') AND (lease_until IS NULL OR lease_until <= CURRENT_TIMESTAMP) AND next_attempt_at <= CURRENT_TIMESTAMP)::int AS due
    FROM webhook_inbox
  `)
  const row = result.rows[0] || {}
  return {
    status: Number(row.quarantined || 0) > 0 || Number(row.due || 0) > 0 ? 'attention' : 'ok',
    total: Number(row.total || 0),
    claimed: Number(row.claimed || 0),
    processed: Number(row.processed || 0),
    retryable: Number(row.retryable || 0),
    quarantined: Number(row.quarantined || 0),
    due: Number(row.due || 0),
    authority: 'durable_webhook_inbox',
    mutation: 'read_only',
    settlementAuthority: false
  }
}

export { FORBIDDEN_PAYLOAD_KEYS, MAX_REPLAY_KEY_LENGTH }
