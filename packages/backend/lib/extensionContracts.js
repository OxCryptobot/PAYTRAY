import crypto from 'node:crypto'
import { ValidationError } from './errors.js'

const VERSION = '2026-08-15'
const SUPPORTED_EVENTS = new Set([
  'engagement.created',
  'engagement.collaboration_degraded',
  'engagement.completed',
  'payment.intent_created',
  'payment.chain_event_projected',
  'payment.reconciliation_attention',
  'discovery.outcome_verified',
  'risk.review_required'
])
const ALLOWED_PROJECTIONS = new Set(['identifiers', 'lifecycle', 'provenance', 'timestamps', 'metrics'])
const FORBIDDEN_KEYS = new Set(['message', 'body', 'content', 'transcript', 'recording', 'audio', 'video', 'rawPayload', 'privateKey', 'signature'])

function assertNoRawContent(value, path = 'value') {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) throw new ValidationError(`${path}.${key} cannot be included in a public extension payload`)
    assertNoRawContent(nested, `${path}.${key}`)
  }
}

function stripForbiddenContent(value) {
  if (Array.isArray(value)) return value.map(stripForbiddenContent)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !FORBIDDEN_KEYS.has(key)).map(([key, nested]) => [key, stripForbiddenContent(nested)]))
}

function safeString(value, fieldName, maxLength = 128) {
  const normalized = String(value || '').trim()
  if (!normalized || normalized.length > maxLength) throw new ValidationError(`${fieldName} is required and must be ${maxLength} characters or fewer`)
  return normalized
}

export function normalizeExtensionHookInput({ event, callbackUrl, projections = ['identifiers', 'lifecycle', 'provenance'], apiVersion = 'v2', replayWindowSeconds = 300 }) {
  if (apiVersion !== 'v2') throw new ValidationError('apiVersion must be v2')
  const normalizedEvent = safeString(event, 'event')
  if (!SUPPORTED_EVENTS.has(normalizedEvent)) throw new ValidationError(`event must be one of: ${[...SUPPORTED_EVENTS].join(', ')}`)
  if (!Array.isArray(projections) || projections.length === 0 || projections.some((projection) => !ALLOWED_PROJECTIONS.has(projection))) throw new ValidationError(`projections must contain only: ${[...ALLOWED_PROJECTIONS].join(', ')}`)
  const replayWindow = Number(replayWindowSeconds)
  if (!Number.isInteger(replayWindow) || replayWindow < 60 || replayWindow > 86400) throw new ValidationError('replayWindowSeconds must be an integer between 60 and 86400')
  return Object.freeze({
    apiVersion,
    contractVersion: VERSION,
    event: normalizedEvent,
    callbackUrl,
    projections: [...new Set(projections)],
    replayWindowSeconds: replayWindow,
    delivery: Object.freeze({ signed: true, retryable: true, deadLetterObservable: true })
  })
}

export function projectExtensionPayload({ hook, payload = {}, occurredAt = new Date().toISOString() }) {
  const safePayload = stripForbiddenContent(payload)
  const projected = {
    apiVersion: hook.apiVersion,
    contractVersion: hook.contractVersion,
    event: hook.event,
    eventId: crypto.randomUUID(),
    occurredAt,
    data: {}
  }
  const source = safePayload && typeof safePayload === 'object' ? safePayload : {}
  if (hook.projections.includes('identifiers')) {
    projected.data.identifiers = Object.fromEntries(Object.entries(source).filter(([key]) => /(^id$|Id$|Wallet$|Address$|Hash$|Type$|Name$)/.test(key)))
  }
  if (hook.projections.includes('lifecycle')) {
    projected.data.lifecycle = Object.fromEntries(Object.entries(source).filter(([key]) => /status|state|projected|finality|outcome|phase/i.test(key)))
  }
  if (hook.projections.includes('provenance')) {
    projected.data.provenance = Object.fromEntries(Object.entries(source).filter(([key]) => /provenance|source|correlation|verifier|lineage|audit/i.test(key)))
  }
  if (hook.projections.includes('timestamps')) {
    projected.data.timestamps = Object.fromEntries(Object.entries(source).filter(([key]) => /at$|time|date/i.test(key)))
  }
  if (hook.projections.includes('metrics')) {
    projected.data.metrics = Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))
  }
  assertNoRawContent(projected, 'projected')
  return projected
}

export function getExtensionContractCapabilities() {
  return {
    apiVersion: 'v2',
    contractVersion: VERSION,
    supportedEvents: [...SUPPORTED_EVENTS].sort(),
    allowedProjections: [...ALLOWED_PROJECTIONS].sort(),
    defaultProjections: ['identifiers', 'lifecycle', 'provenance'],
    forbiddenPayloadKeys: [...FORBIDDEN_KEYS].sort(),
    delivery: { signed: true, retryable: true, deadLetterObservable: true, replayWindowBounded: true },
    settlementAuthority: false,
    mutation: 'read_only'
  }
}

export { ALLOWED_PROJECTIONS, FORBIDDEN_KEYS, SUPPORTED_EVENTS, VERSION, stripForbiddenContent }
