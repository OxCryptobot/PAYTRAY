import crypto from 'node:crypto'

const FORBIDDEN_CONTENT_KEYS = new Set(['message', 'body', 'transcript', 'recording', 'audio', 'video', 'privateKey', 'signature', 'rawPayload', 'content', 'prompt'])
const ALLOWED_TASK_TYPES = new Set(['conversation_assistance', 'discovery_assistance', 'risk_triage'])

export class AdvisoryAiBoundaryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AdvisoryAiBoundaryError'
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((result, key) => { result[key] = canonicalize(value[key]); return result }, {})
  return value
}

function hashStructured(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function assertNoRawContent(value, path = 'value') {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CONTENT_KEYS.has(key)) throw new AdvisoryAiBoundaryError(`${path}.${key} cannot cross the persisted advisory-AI boundary`)
    assertNoRawContent(nested, `${path}.${key}`)
  }
}

function futureRetention(retentionDays, now) {
  const days = Number(retentionDays)
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new AdvisoryAiBoundaryError('retentionDays must be an integer between 1 and 3650')
  return new Date(now.getTime() + days * 86400000).toISOString()
}

function requireSourceEventIds(provenance) {
  const sourceEventIds = Array.isArray(provenance?.sourceEventIds) ? [...new Set(provenance.sourceEventIds)] : []
  if (!sourceEventIds.length || sourceEventIds.some((id) => typeof id !== 'string' || !id)) {
    throw new AdvisoryAiBoundaryError('provenance.sourceEventIds must contain event IDs')
  }
  return sourceEventIds
}

export function normalizeRetrievalEvidence(items, maxItems = 20) {
  if (!Array.isArray(items)) throw new AdvisoryAiBoundaryError('retrievalItems must be an array')
  const limit = Number(maxItems)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AdvisoryAiBoundaryError('maxRetrievalItems must be an integer between 1 and 100')
  return items.slice(0, limit).map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AdvisoryAiBoundaryError(`retrievalItems[${index}] must be an object`)
    assertNoRawContent(item, `retrievalItems[${index}]`)
    if (!item.id || !item.sourceType || !item.sourceId) throw new AdvisoryAiBoundaryError(`retrievalItems[${index}] requires id, sourceType, and sourceId`)
    const score = item.score == null ? null : Number(item.score)
    if (score != null && (!Number.isFinite(score) || score < 0 || score > 1)) throw new AdvisoryAiBoundaryError(`retrievalItems[${index}].score must be between 0 and 1`)
    return {
      id: String(item.id),
      sourceType: String(item.sourceType),
      sourceId: String(item.sourceId),
      score,
      featureVersion: item.featureVersion ? String(item.featureVersion) : null,
      evidenceHash: item.evidenceHash ? String(item.evidenceHash) : null
    }
  })
}

export function getAdvisoryAiCapabilities({ config }) {
  return {
    enabled: config.advisoryAi.enabled,
    providerConfigured: Boolean(config.advisoryAi.providerName && config.advisoryAi.modelName),
    providerName: config.advisoryAi.providerName,
    modelName: config.advisoryAi.modelName,
    maxLatencyMs: config.advisoryAi.maxLatencyMs,
    maxCostMicrounits: config.advisoryAi.maxCostMicrounits,
    maxRetrievalItems: config.advisoryAi.maxRetrievalItems,
    retentionDays: config.advisoryAi.retentionDays,
    rawContentPersistence: false,
    humanReviewRequired: true,
    promotionStatus: 'shadow_only',
    settlementAuthority: false,
    applied: false,
    mutation: 'read_only'
  }
}

export function isAdvisoryAiCapabilityReady(capabilities = {}) {
  return capabilities.enabled === true
    && capabilities.providerConfigured === true
    && Number.isInteger(capabilities.maxLatencyMs) && capabilities.maxLatencyMs > 0
    && Number.isInteger(capabilities.maxCostMicrounits) && capabilities.maxCostMicrounits >= 0
    && Number.isInteger(capabilities.maxRetrievalItems) && capabilities.maxRetrievalItems >= 1 && capabilities.maxRetrievalItems <= 100
    && Number.isInteger(capabilities.retentionDays) && capabilities.retentionDays >= 1 && capabilities.retentionDays <= 3650
    && capabilities.rawContentPersistence === false
    && capabilities.humanReviewRequired === true
    && capabilities.promotionStatus === 'shadow_only'
    && capabilities.settlementAuthority === false
    && capabilities.applied === false
    && capabilities.mutation === 'read_only'
}

export function createAdvisoryAiRequest({ taskType, subject, retrievalItems = [], provenance, config, now = new Date() }) {
  if (!ALLOWED_TASK_TYPES.has(taskType)) throw new AdvisoryAiBoundaryError('Unsupported advisory-AI task type')
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) throw new AdvisoryAiBoundaryError('subject must be an object')
  assertNoRawContent(subject, 'subject')
  const sourceEventIds = requireSourceEventIds(provenance)
  const normalizedRetrieval = normalizeRetrievalEvidence(retrievalItems, config.advisoryAi.maxRetrievalItems)
  const input = {
    taskType,
    subject: canonicalize(subject),
    retrievalEvidence: normalizedRetrieval,
    sourceEventIds
  }
  return Object.freeze({
    taskType,
    input,
    inputHash: hashStructured(input),
    provenance: { ...canonicalize(provenance), sourceEventIds },
    retrievalEvidence: normalizedRetrieval,
    retentionUntil: futureRetention(config.advisoryAi.retentionDays, now),
    rawContentPersisted: false,
    humanOverrideRequired: true,
    applied: false,
    promotionStatus: 'shadow_only',
    settlementAuthority: false,
    mutation: 'read_only'
  })
}

export async function runBoundedAdvisory({ provider, request, config, now = new Date() }) {
  if (!config.advisoryAi.enabled) return { status: 'blocked', reason: 'advisory AI is disabled', ...getAdvisoryAiCapabilities({ config }) }
  if (!config.advisoryAi.providerName || !config.advisoryAi.modelName) return { status: 'blocked', reason: 'advisory AI provider and model are not configured', ...getAdvisoryAiCapabilities({ config }) }
  if (!provider || typeof provider.complete !== 'function') return { status: 'blocked', reason: 'advisory AI provider must implement complete(request)', ...getAdvisoryAiCapabilities({ config }) }

  const startedAt = Date.now()
  let timer
  const controller = new AbortController()
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => provider.complete(request.input, { signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new AdvisoryAiBoundaryError('advisory AI provider exceeded latency budget'))
        }, config.advisoryAi.maxLatencyMs)
      })
    ])
    const latencyMs = Date.now() - startedAt
    if (latencyMs > config.advisoryAi.maxLatencyMs) throw new AdvisoryAiBoundaryError('advisory AI provider exceeded latency budget')
    const costMicrounits = Number(response?.costMicrounits)
    if (!Number.isInteger(costMicrounits) || costMicrounits < 0) throw new AdvisoryAiBoundaryError('provider response costMicrounits must be a non-negative integer')
    if (costMicrounits > config.advisoryAi.maxCostMicrounits) throw new AdvisoryAiBoundaryError('advisory AI provider exceeded cost budget')
    if (!response?.output || typeof response.output !== 'object' || Array.isArray(response.output)) throw new AdvisoryAiBoundaryError('provider response output must be an object')
    assertNoRawContent(response.output, 'output')
    return {
      status: 'advisory',
      output: response.output,
      providerRequestHash: request.inputHash,
      provenance: request.provenance,
      retrievalEvidence: request.retrievalEvidence,
      latencyMs,
      costMicrounits,
      retentionUntil: request.retentionUntil,
      rawContentPersisted: false,
      humanOverrideRequired: true,
      applied: false,
      promotionStatus: 'shadow_only',
      settlementAuthority: false,
      authority: 'advisory_ai_only',
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      asOf: now.toISOString()
    }
  } catch (error) {
    return {
      status: 'blocked',
      reason: error.message,
      providerRequestHash: request.inputHash,
      provenance: request.provenance,
      retrievalEvidence: request.retrievalEvidence,
      latencyMs: Date.now() - startedAt,
      rawContentPersisted: false,
      humanOverrideRequired: true,
      applied: false,
      promotionStatus: 'shadow_only',
      settlementAuthority: false,
      authority: 'advisory_ai_only',
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export { assertNoRawContent, hashStructured, ALLOWED_TASK_TYPES }
