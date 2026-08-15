import { ValidationError } from './errors.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_OFFSET = 100_000
const SENSITIVE_KEY = /(authorization|access.?token|api.?key|cookie|jwt|password|private.?key|secret|signature)/i

function parseInteger(value, field, { defaultValue, minimum, maximum }) {
  if (value == null || value === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

function optionalString(value, field, maxLength = 255) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value.length > maxLength || !value.trim()) {
    throw new ValidationError(`${field} must be a non-empty string up to ${maxLength} characters`)
  }
  return value.trim()
}

function redactMetadata(value, depth = 0) {
  if (depth > 6) return '[REDACTED_DEPTH]'
  if (Array.isArray(value)) return value.map((item) => redactMetadata(item, depth + 1))
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactMetadata(item, depth + 1)
  ]))
}

function normalizeOptions(options = {}) {
  return {
    limit: parseInteger(options.limit, 'limit', { defaultValue: DEFAULT_LIMIT, minimum: 1, maximum: MAX_LIMIT }),
    offset: parseInteger(options.offset, 'offset', { defaultValue: 0, minimum: 0, maximum: MAX_OFFSET }),
    actorType: optionalString(options.actorType, 'actorType', 32),
    actorId: optionalString(options.actorId, 'actorId'),
    action: optionalString(options.action, 'action', 128),
    entityType: optionalString(options.entityType, 'entityType', 64),
    entityId: optionalString(options.entityId, 'entityId', 64),
    correlationId: optionalString(options.correlationId, 'correlationId', 64)
  }
}

function buildFilters(options) {
  const filters = [
    ['actor_type', options.actorType],
    ['actor_id', options.actorId],
    ['action', options.action],
    ['entity_type', options.entityType],
    ['entity_id', options.entityId],
    ['correlation_id', options.correlationId]
  ]
  const clauses = []
  const params = []
  for (const [column, value] of filters) {
    if (value == null) continue
    params.push(value)
    clauses.push(`${column} = $${params.length}`)
  }
  return { clauses, params }
}

function mapAuditEvent(row) {
  return {
    id: row.id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    correlationId: row.correlation_id,
    metadata: redactMetadata(row.metadata || {}),
    createdAt: row.created_at
  }
}

export async function listFinancialAuditEvents({ client, ...input }) {
  if (!client || typeof client.query !== 'function') {
    throw new ValidationError('A database client is required')
  }

  const options = normalizeOptions(input)
  const { clauses, params } = buildFilters(options)
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const countResult = await client.query(
    `SELECT COUNT(*)::int AS count FROM financial_audit_events ${where}`,
    params
  )
  const total = Number(countResult.rows[0]?.count || 0)
  const eventResult = await client.query(
    `SELECT id, actor_type, actor_id, action, entity_type, entity_id, correlation_id, metadata, created_at
     FROM financial_audit_events
     ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, options.limit, options.offset]
  )

  return {
    status: 'ok',
    authority: 'financial_audit_events',
    mutation: 'read_only',
    events: eventResult.rows.map(mapAuditEvent),
    pagination: {
      limit: options.limit,
      offset: options.offset,
      total,
      hasMore: options.offset + eventResult.rows.length < total
    },
    filters: {
      actorType: options.actorType,
      actorId: options.actorId,
      action: options.action,
      entityType: options.entityType,
      entityId: options.entityId,
      correlationId: options.correlationId
    }
  }
}

export { normalizeOptions, redactMetadata }
