const FORBIDDEN_CONTENT_KEYS = new Set(['message', 'body', 'transcript', 'recording', 'audio', 'video', 'privateKey', 'signature', 'rawPayload'])

function assertNoRawContent(value, path = 'value') {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CONTENT_KEYS.has(key)) throw new Error(`${path}.${key} cannot be persisted in advisory AI evidence`)
    assertNoRawContent(nested, `${path}.${key}`)
  }
}

function asFutureDate(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime()) || date <= new Date()) throw new Error('retentionUntil must be a future timestamp')
  return date.toISOString()
}

export function createCollaborationAdvisoryGuardrails({ provenance = {}, retentionUntil, latencyMs, costMicrounits, humanOverride = false, output = {} }) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) throw new Error('provenance must be an object')
  const sourceEventIds = Array.isArray(provenance.sourceEventIds) ? [...new Set(provenance.sourceEventIds)] : []
  if (!sourceEventIds.length || sourceEventIds.some((id) => typeof id !== 'string' || !id)) throw new Error('provenance.sourceEventIds must contain event IDs')
  const latency = Number(latencyMs)
  const cost = Number(costMicrounits)
  if (!Number.isInteger(latency) || latency < 0 || latency > 60000) throw new Error('latencyMs must be an integer between 0 and 60000')
  if (!Number.isInteger(cost) || cost < 0) throw new Error('costMicrounits must be a non-negative integer')
  if (humanOverride !== false && humanOverride !== true) throw new Error('humanOverride must be boolean')
  assertNoRawContent(provenance, 'provenance')
  assertNoRawContent(output, 'output')
  return Object.freeze({
    taskType: 'conversation_assistance',
    provenance: { ...provenance, sourceEventIds },
    retentionUntil: asFutureDate(retentionUntil),
    latencyMs: latency,
    costMicrounits: cost,
    humanOverrideRequired: true,
    humanOverride,
    applied: false,
    settlementAuthority: false,
    rawContentPersisted: false
  })
}
