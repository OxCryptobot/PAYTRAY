import crypto from 'node:crypto'

export class OutboxDeliveryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OutboxDeliveryError'
  }
}

function required(value, fieldName) {
  if (value == null || value === '') throw new OutboxDeliveryError(`${fieldName} is required`)
  return value
}

function positiveInteger(value, fieldName, maximum = 100) {
  const normalized = Number(value)
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new OutboxDeliveryError(`${fieldName} must be an integer between 1 and ${maximum}`)
  }
  return normalized
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex')
}

function statusFor(row, maxAttempts) {
  if (row.processed_at) return 'processed'
  if (Number(row.attempts) >= maxAttempts) return 'dead'
  if (row.last_error) return 'failed'
  if (row.available_at && new Date(row.available_at).getTime() > Date.now()) return 'leased'
  return 'pending'
}

function safeEvent(row, maxAttempts) {
  return {
    id: row.id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    availableAt: row.available_at,
    processedAt: row.processed_at,
    attempts: Number(row.attempts || 0),
    maxAttempts,
    status: statusFor(row, maxAttempts),
    lastError: row.last_error ? String(row.last_error).slice(0, 500) : null,
    payloadSha256: hashPayload(row.payload),
    payloadKeys: row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? Object.keys(row.payload).sort() : []
  }
}

export async function enqueueOutboxEvent({ client, aggregateType, aggregateId, eventType, payload = {}, correlationId = null, availableAt = null }) {
  const result = await client.query(`
    INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload, correlation_id, available_at)
    VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::uuid, uuid_generate_v4()), COALESCE($6::timestamp, CURRENT_TIMESTAMP))
    RETURNING *
  `, [
    required(aggregateType, 'aggregateType'),
    required(aggregateId, 'aggregateId'),
    required(eventType, 'eventType'),
    JSON.stringify(payload),
    correlationId,
    availableAt
  ])
  return safeEvent(result.rows[0], Number.MAX_SAFE_INTEGER)
}

export async function claimOutboxEvents({ client, limit = 25, leaseMs = 120000, maxAttempts = 5 }) {
  const boundedLimit = positiveInteger(limit, 'limit')
  const boundedLeaseMs = positiveInteger(leaseMs, 'leaseMs', 3600000)
  const boundedMaxAttempts = positiveInteger(maxAttempts, 'maxAttempts', 100)
  const result = await client.query(`
    WITH picked AS (
      SELECT id
      FROM outbox_events
      WHERE processed_at IS NULL
        AND available_at <= CURRENT_TIMESTAMP
        AND attempts < $2
      ORDER BY available_at, occurred_at
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE outbox_events event
    SET attempts = event.attempts + 1,
        available_at = CURRENT_TIMESTAMP + ($3::bigint * INTERVAL '1 millisecond')
    FROM picked
    WHERE event.id = picked.id
    RETURNING event.*
  `, [boundedLimit, boundedMaxAttempts, boundedLeaseMs])
  return result.rows.map((row) => safeEvent(row, boundedMaxAttempts))
}

export async function markOutboxProcessed({ client, eventId }) {
  const result = await client.query(`
    UPDATE outbox_events
    SET processed_at = CURRENT_TIMESTAMP, last_error = NULL
    WHERE id = $1 AND processed_at IS NULL
    RETURNING id, processed_at
  `, [required(eventId, 'eventId')])
  return result.rows[0] || null
}

export async function recordOutboxFailure({ client, eventId, error, retryBaseDelayMs = 1000, maxAttempts = 5 }) {
  const boundedDelay = positiveInteger(retryBaseDelayMs, 'retryBaseDelayMs', 86400000)
  const boundedMaxAttempts = positiveInteger(maxAttempts, 'maxAttempts', 100)
  const message = String(error?.message || error || 'outbox delivery failed').slice(0, 500)
  const result = await client.query(`
    UPDATE outbox_events
    SET last_error = $2,
        available_at = CASE
          WHEN attempts >= $3 THEN CURRENT_TIMESTAMP
          ELSE CURRENT_TIMESTAMP + (($4::bigint * (2 ^ GREATEST(attempts - 1, 0))) * INTERVAL '1 millisecond')
        END
    WHERE id = $1 AND processed_at IS NULL
    RETURNING *
  `, [required(eventId, 'eventId'), message, boundedMaxAttempts, boundedDelay])
  return result.rows[0] ? safeEvent(result.rows[0], boundedMaxAttempts) : null
}

export async function getOutboxHealth({ client, maxAttempts = 5, now = new Date() }) {
  const boundedMaxAttempts = positiveInteger(maxAttempts, 'maxAttempts', 100)
  const result = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int AS processed,
      COUNT(*) FILTER (WHERE processed_at IS NULL AND attempts = 0 AND available_at <= CURRENT_TIMESTAMP)::int AS pending,
      COUNT(*) FILTER (WHERE processed_at IS NULL AND attempts > 0 AND attempts < $1 AND available_at > CURRENT_TIMESTAMP)::int AS leased,
      COUNT(*) FILTER (WHERE processed_at IS NULL AND last_error IS NOT NULL AND attempts < $1)::int AS failed,
      COUNT(*) FILTER (WHERE processed_at IS NULL AND attempts >= $1)::int AS dead,
      COUNT(*) FILTER (WHERE processed_at IS NULL AND available_at <= CURRENT_TIMESTAMP AND attempts < $1)::int AS due,
      MIN(occurred_at) FILTER (WHERE processed_at IS NULL)::timestamp AS oldest_pending_at,
      MAX(processed_at)::timestamp AS latest_processed_at
    FROM outbox_events
  `, [boundedMaxAttempts])
  const row = result.rows[0] || {}
  const total = Number(row.total || 0)
  const processed = Number(row.processed || 0)
  const dead = Number(row.dead || 0)
  const due = Number(row.due || 0)
  return {
    status: dead > 0 ? 'attention' : 'ok',
    asOf: now.toISOString(),
    total,
    processed,
    pending: Number(row.pending || 0),
    leased: Number(row.leased || 0),
    failed: Number(row.failed || 0),
    dead,
    due,
    oldestPendingAt: row.oldest_pending_at,
    latestProcessedAt: row.latest_processed_at,
    deliverySuccessRate: total ? Number((processed / total).toFixed(6)) : 1,
    retryableCount: Number(row.failed || 0) + due,
    maxAttempts: boundedMaxAttempts,
    authority: 'durable_outbox_delivery_health',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function listOutboxEvents({ client, limit = 50, offset = 0, status = null, maxAttempts = 5 }) {
  const boundedLimit = positiveInteger(limit, 'limit', 100)
  const normalizedOffset = Number(offset)
  if (!Number.isInteger(normalizedOffset) || normalizedOffset < 0 || normalizedOffset > 100000) throw new OutboxDeliveryError('offset must be an integer between 0 and 100000')
  const boundedMaxAttempts = positiveInteger(maxAttempts, 'maxAttempts', 100)
  const allowedStatuses = new Set(['processed', 'pending', 'leased', 'failed', 'dead'])
  if (status != null && !allowedStatuses.has(status)) throw new OutboxDeliveryError(`status must be one of ${[...allowedStatuses].join(', ')}`)
  const result = await client.query(`
    SELECT * FROM outbox_events
    WHERE ($3::text IS NULL
      OR ($3 = 'processed' AND processed_at IS NOT NULL)
      OR ($3 = 'dead' AND processed_at IS NULL AND attempts >= $4)
      OR ($3 = 'failed' AND processed_at IS NULL AND last_error IS NOT NULL AND attempts < $4)
      OR ($3 = 'leased' AND processed_at IS NULL AND attempts > 0 AND attempts < $4 AND available_at > CURRENT_TIMESTAMP)
      OR ($3 = 'pending' AND processed_at IS NULL AND attempts = 0 AND available_at <= CURRENT_TIMESTAMP))
    ORDER BY occurred_at DESC
    LIMIT $1 OFFSET $2
  `, [boundedLimit, normalizedOffset, status, boundedMaxAttempts])
  return result.rows.map((row) => safeEvent(row, boundedMaxAttempts))
}

export { hashPayload, safeEvent, statusFor }
