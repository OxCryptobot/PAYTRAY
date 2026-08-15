import { ValidationError } from './errors.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const MAX_OFFSET = 100_000
const VERIFICATION_STATUSES = new Set(['verified', 'unverified', 'rejected'])

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
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new ValidationError(`${field} must be a non-empty string up to ${maxLength} characters`)
  }
  return value.trim()
}

function normalizeOptions(options = {}) {
  const verificationStatus = optionalString(options.verificationStatus, 'verificationStatus', 32)
  if (verificationStatus && !VERIFICATION_STATUSES.has(verificationStatus)) {
    throw new ValidationError('verificationStatus must be verified, unverified, or rejected')
  }
  return {
    queryId: optionalString(options.queryId, 'queryId'),
    candidateProfileId: optionalString(options.candidateProfileId, 'candidateProfileId', 64),
    verificationStatus,
    limit: parseInteger(options.limit, 'limit', { defaultValue: DEFAULT_LIMIT, minimum: 1, maximum: MAX_LIMIT }),
    offset: parseInteger(options.offset, 'offset', { defaultValue: 0, minimum: 0, maximum: MAX_OFFSET })
  }
}

function buildWhere(options) {
  const clauses = []
  const params = []
  if (options.queryId) {
    params.push(options.queryId)
    clauses.push(`di.query_id = $${params.length}`)
  }
  if (options.candidateProfileId) {
    params.push(options.candidateProfileId)
    clauses.push(`di.candidate_profile_id = $${params.length}`)
  }
  if (options.verificationStatus) {
    params.push(options.verificationStatus)
    clauses.push(`o.verification_status = $${params.length}`)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

function lineageStatus(outcomes) {
  if (outcomes.some((outcome) => outcome.verificationStatus === 'verified')) return 'verified_outcome'
  if (outcomes.some((outcome) => outcome.verificationStatus === 'unverified')) return 'unverified_outcome'
  if (outcomes.some((outcome) => outcome.verificationStatus === 'rejected')) return 'rejected_outcome'
  return 'engaged_no_outcome'
}

export async function listDiscoveryOutcomeLineage({ client, ...input }) {
  if (!client || typeof client.query !== 'function') {
    throw new ValidationError('A database client is required')
  }
  const options = normalizeOptions(input)
  const { where, params } = buildWhere(options)
  const countResult = await client.query(
    `SELECT COUNT(DISTINCT di.id)::int AS count
     FROM discovery_impressions di
     LEFT JOIN engagements e ON e.id = di.engagement_id
     LEFT JOIN engagement_outcome_events o ON o.engagement_id = e.id
     ${where}`,
    params
  )
  const total = Number(countResult.rows[0]?.count || 0)
  const rowResult = await client.query(
    `SELECT di.id AS impression_id,
            di.query_id,
            di.candidate_profile_id,
            di.engagement_id,
            di.rank_position,
            di.ranking_version,
            di.selected,
            di.observed_at,
            di.provenance,
            o.id AS outcome_id,
            o.event_type,
            o.evidence_type,
            o.evidence_id,
            o.verification_status,
            o.occurred_at AS outcome_occurred_at
     FROM discovery_impressions di
     LEFT JOIN engagements e ON e.id = di.engagement_id
     LEFT JOIN engagement_outcome_events o ON o.engagement_id = e.id
     ${where}
     ORDER BY di.observed_at DESC, di.id DESC, o.occurred_at DESC NULLS LAST
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, options.limit, options.offset]
  )

  const grouped = new Map()
  for (const row of rowResult.rows) {
    let entry = grouped.get(row.impression_id)
    if (!entry) {
      entry = {
        impressionId: row.impression_id,
        queryId: row.query_id,
        candidateProfileId: row.candidate_profile_id,
        engagementId: row.engagement_id,
        rankPosition: row.rank_position,
        rankingVersion: row.ranking_version,
        selected: row.selected,
        observedAt: row.observed_at,
        provenance: row.provenance || {},
        outcomes: []
      }
      grouped.set(row.impression_id, entry)
    }
    if (row.outcome_id) {
      entry.outcomes.push({
        id: row.outcome_id,
        eventType: row.event_type,
        evidenceType: row.evidence_type,
        evidenceId: row.evidence_id,
        verificationStatus: row.verification_status,
        occurredAt: row.outcome_occurred_at
      })
    }
  }

  const impressions = Array.from(grouped.values()).map((entry) => ({
    ...entry,
    lineageStatus: entry.engagementId ? lineageStatus(entry.outcomes) : 'unlinked'
  }))

  return {
    status: 'ok',
    authority: 'verified_outcome_lineage',
    mutation: 'read_only',
    rawContentIncluded: false,
    impressions,
    pagination: {
      limit: options.limit,
      offset: options.offset,
      total,
      hasMore: options.offset + impressions.length < total
    },
    filters: options
  }
}

export { normalizeOptions }
