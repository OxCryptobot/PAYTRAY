import crypto from 'crypto'

const EVENT_TYPES = new Set(['discovery_impression', 'match_selected', 'engagement_created', 'collaboration_state_changed', 'payment_intent_created', 'payment_chain_event_verified', 'ledger_entry_reflected', 'outcome_verified', 'shadow_evaluation_completed'])
const PRIVACY_CLASSES = new Set(['operational', 'derived_non_content', 'sensitive_derived', 'restricted'])
const FORBIDDEN_KEYS = new Set(['message', 'body', 'transcript', 'recording', 'audio', 'video', 'privateKey', 'signature', 'rawPayload'])

export class TelemetryValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TelemetryValidationError'
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[key] = canonicalize(value[key]); return result }, {})
  return value
}

export function hashTelemetryPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex')
}

function rejectForbidden(value, path = 'payload') {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new TelemetryValidationError(`${path}.${key} is not allowed in production telemetry`)
    if (nested && typeof nested === 'object') rejectForbidden(nested, `${path}.${key}`)
  }
}

function timestamp(value, field) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new TelemetryValidationError(`${field} must be a valid timestamp`)
  return date
}

export function normalizeTelemetryEvent(input, receivedAt = new Date()) {
  if (!input || typeof input !== 'object') throw new TelemetryValidationError('Telemetry event must be an object')
  if (!input.eventId || !input.eventType || !input.entityType || !input.entityId) throw new TelemetryValidationError('eventId, eventType, entityType, and entityId are required')
  if (!EVENT_TYPES.has(input.eventType)) throw new TelemetryValidationError('Unsupported telemetry event type')
  if (!PRIVACY_CLASSES.has(input.privacyClass)) throw new TelemetryValidationError('Unsupported telemetry privacy class')
  const payload = input.payload || {}
  rejectForbidden(payload)
  const occurredAt = timestamp(input.occurredAt, 'occurredAt')
  const received = timestamp(receivedAt, 'receivedAt')
  if (occurredAt.getTime() > received.getTime() + 5 * 60 * 1000) throw new TelemetryValidationError('occurredAt cannot be materially after receivedAt')
  return Object.freeze({
    eventId: String(input.eventId),
    eventType: input.eventType,
    occurredAt: occurredAt.toISOString(),
    receivedAt: received.toISOString(),
    actorScope: String(input.actorScope || 'system'),
    entityType: String(input.entityType),
    entityId: String(input.entityId),
    correlationId: input.correlationId || null,
    schemaVersion: String(input.schemaVersion || '1'),
    source: String(input.source || 'paytray'),
    privacyClass: input.privacyClass,
    payload: canonicalize(payload),
    payloadHash: hashTelemetryPayload(payload),
    provenance: canonicalize(input.provenance || {})
  })
}

export async function ingestTelemetryEvent({ client, event, receivedAt = new Date() }) {
  const normalized = normalizeTelemetryEvent(event, receivedAt)
  const inserted = await client.query(
    `INSERT INTO production_telemetry_events (
      event_id, event_type, occurred_at, received_at, actor_scope,
      entity_type, entity_id, correlation_id, schema_version, source,
      privacy_class, payload, payload_hash, provenance
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING *`,
    [normalized.eventId, normalized.eventType, normalized.occurredAt, normalized.receivedAt, normalized.actorScope, normalized.entityType, normalized.entityId, normalized.correlationId, normalized.schemaVersion, normalized.source, normalized.privacyClass, JSON.stringify(normalized.payload), normalized.payloadHash, JSON.stringify(normalized.provenance)]
  )
  if (inserted.rows[0]) return { event: inserted.rows[0], idempotentReplay: false, ingestionLagMs: new Date(normalized.receivedAt).getTime() - new Date(normalized.occurredAt).getTime() }
  const existing = await client.query('SELECT * FROM production_telemetry_events WHERE event_id = $1', [normalized.eventId])
  return { event: existing.rows[0], idempotentReplay: true, ingestionLagMs: new Date(normalized.receivedAt).getTime() - new Date(normalized.occurredAt).getTime() }
}

export { EVENT_TYPES, PRIVACY_CLASSES }
