import crypto from 'crypto'

const FORBIDDEN_CONTENT_KEYS = new Set(['message', 'body', 'transcript', 'recording', 'audio', 'video', 'privateKey', 'signature'])
const ENTITY_TYPES = new Set(['expert_profile', 'engagement', 'payment_stream', 'conversation'])
const TASK_TYPES = new Set(['ranking', 'conversation_assistance', 'risk_scoring'])

export class AiEvaluationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AiEvaluationError'
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key])
      return result
    }, {})
  }
  return value
}

export function hashStructuredInput(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function assertSafeDerivedFeatures(value, path = 'features') {
  if (!value || typeof value !== 'object') throw new AiEvaluationError(`${path} must be an object`)
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CONTENT_KEYS.has(key)) throw new AiEvaluationError(`${path}.${key} cannot be stored in AI feature data`)
    if (nested && typeof nested === 'object') assertSafeDerivedFeatures(nested, `${path}.${key}`)
  }
}

function asDate(value, fieldName) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new AiEvaluationError(`${fieldName} must be a valid timestamp`)
  return date
}

export function createFeatureSnapshot({ entityType, entityId, featureVersion, asOf, features, sourceEventIds = [], privacyClass = 'derived_non_content', retentionUntil }) {
  if (!ENTITY_TYPES.has(entityType)) throw new AiEvaluationError('Unsupported feature snapshot entity type')
  if (!entityId || !featureVersion) throw new AiEvaluationError('Feature snapshot entityId and featureVersion are required')
  const snapshotTime = asDate(asOf, 'asOf')
  const retention = asDate(retentionUntil, 'retentionUntil')
  if (retention <= snapshotTime) throw new AiEvaluationError('retentionUntil must be after asOf')
  assertSafeDerivedFeatures(features)
  if (!Array.isArray(sourceEventIds) || sourceEventIds.some((id) => typeof id !== 'string')) {
    throw new AiEvaluationError('sourceEventIds must be an array of string IDs')
  }
  return Object.freeze({
    entityType,
    entityId,
    featureVersion,
    asOf: snapshotTime.toISOString(),
    features: canonicalize(features),
    sourceEventIds: [...new Set(sourceEventIds)],
    sourceHash: hashStructuredInput({ entityType, entityId, featureVersion, asOf: snapshotTime.toISOString(), features }),
    privacyClass,
    retentionUntil: retention.toISOString()
  })
}

export function createEvaluationExample({ datasetVersion, queryId, candidateProfileId, engagementId = null, labelType, labelValue, labelVerificationStatus, split, asOf, sourceEventIds = [], provenance = {} }) {
  if (!datasetVersion || !queryId || !candidateProfileId) throw new AiEvaluationError('Evaluation dataset, query, and candidate IDs are required')
  if (!Number.isFinite(Number(labelValue)) || Number(labelValue) < 0) throw new AiEvaluationError('labelValue must be a non-negative number')
  if (!['selected', 'conversation_started', 'payment_intent', 'completed', 'repeat_booking', 'disputed'].includes(labelType)) throw new AiEvaluationError('Unsupported evaluation label type')
  if (!['verified', 'unverified', 'rejected'].includes(labelVerificationStatus)) throw new AiEvaluationError('Unsupported label verification status')
  if (!['train', 'validation', 'test', 'shadow'].includes(split)) throw new AiEvaluationError('Unsupported evaluation split')
  const timestamp = asDate(asOf, 'asOf')
  if (labelVerificationStatus !== 'verified' && split !== 'shadow') throw new AiEvaluationError('Non-verified labels may only be used in shadow split')
  return Object.freeze({
    datasetVersion,
    queryId,
    candidateProfileId,
    engagementId,
    labelType,
    labelValue: Number(labelValue),
    labelVerificationStatus,
    split,
    asOf: timestamp.toISOString(),
    sourceEventIds: [...new Set(sourceEventIds)],
    provenance: canonicalize(provenance)
  })
}

export function createShadowDecision({ taskType, entityType, entityId, modelVersion, input, output, confidence = null, reasonCodes = [], evaluationRunId = null }) {
  if (!TASK_TYPES.has(taskType)) throw new AiEvaluationError('Unsupported shadow task type')
  if (!ENTITY_TYPES.has(entityType)) throw new AiEvaluationError('Unsupported shadow entity type')
  if (!entityId || !modelVersion) throw new AiEvaluationError('Shadow decision entityId and modelVersion are required')
  if (confidence != null && (!Number.isFinite(Number(confidence)) || confidence < 0 || confidence > 1)) throw new AiEvaluationError('confidence must be between 0 and 1')
  if (!Array.isArray(reasonCodes)) throw new AiEvaluationError('reasonCodes must be an array')
  return Object.freeze({
    evaluationRunId,
    taskType,
    entityType,
    entityId,
    modelVersion,
    inputHash: hashStructuredInput(input),
    output: canonicalize(output),
    confidence: confidence == null ? null : Number(confidence),
    reasonCodes: [...reasonCodes],
    applied: false,
    humanReviewStatus: 'not_reviewed'
  })
}

function dcg(relevances) {
  return relevances.reduce((sum, relevance, index) => sum + (2 ** relevance - 1) / Math.log2(index + 2), 0)
}

export function precisionAtK(rankedIds, relevantIds, k) {
  const top = rankedIds.slice(0, k)
  const relevant = new Set(relevantIds)
  return top.length ? top.filter((id) => relevant.has(id)).length / top.length : 0
}

export function recallAtK(rankedIds, relevantIds, k) {
  if (!relevantIds.length) return 0
  const relevant = new Set(relevantIds)
  return rankedIds.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size
}

export function ndcgAtK(rankedIds, relevanceById, k) {
  const actual = rankedIds.slice(0, k).map((id) => Number(relevanceById[id] || 0))
  const ideal = Object.values(relevanceById).map(Number).sort((a, b) => b - a).slice(0, k)
  const idealDcg = dcg(ideal)
  return idealDcg ? dcg(actual) / idealDcg : 0
}

export function evaluateRankingQueries(queries, k = 3) {
  if (!Array.isArray(queries)) throw new AiEvaluationError('queries must be an array')
  const metrics = queries.map((query) => {
    const relevanceById = query.relevanceById || {}
    const relevantIds = Object.entries(relevanceById).filter(([, value]) => Number(value) > 0).map(([id]) => id)
    return {
      queryId: query.queryId,
      precisionAtK: precisionAtK(query.rankedIds || [], relevantIds, k),
      recallAtK: recallAtK(query.rankedIds || [], relevantIds, k),
      ndcgAtK: ndcgAtK(query.rankedIds || [], relevanceById, k)
    }
  })
  const average = (field) => metrics.length ? Number((metrics.reduce((sum, item) => sum + item[field], 0) / metrics.length).toFixed(6)) : 0
  return {
    queryCount: metrics.length,
    k,
    precisionAtK: average('precisionAtK'),
    recallAtK: average('recallAtK'),
    ndcgAtK: average('ndcgAtK'),
    byQuery: metrics
  }
}

export { ENTITY_TYPES, TASK_TYPES }
