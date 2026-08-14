const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const SCORE_WEIGHTS = Object.freeze({
  skillMatch: 0.35,
  outcomeHistory: 0.2,
  completionRate: 0.15,
  responseLatency: 0.1,
  availability: 0.08,
  verification: 0.07,
  rateFit: 0.05
})

export class DiscoveryServiceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DiscoveryServiceError'
  }
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0))
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item).toLowerCase()) : []
}

function scoreSkillMatch(candidate, queryTokens) {
  if (!queryTokens.length) return 0.5
  const searchable = new Set([
    ...normalizeArray(candidate.expertise),
    ...tokenize(candidate.name),
    ...tokenize(candidate.bio)
  ].flatMap(tokenize))
  const matched = queryTokens.filter((token) => searchable.has(token))
  return { score: clamp(matched.length / queryTokens.length), matched }
}

function scoreRateFit(candidate, maxHourlyRate) {
  if (!maxHourlyRate) return 0.5
  const hourlyRate = Number(candidate.hourly_rate ?? candidate.hourlyRate)
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) return 0
  if (hourlyRate <= maxHourlyRate) return 1
  return clamp(maxHourlyRate / hourlyRate)
}

function scoreResponseLatency(seconds) {
  if (seconds == null) return 0.5
  return clamp(1 - Number(seconds) / (24 * 60 * 60))
}

function scoreAvailability(status) {
  return { today: 1, this_week: 0.8, available: 0.75, busy: 0.25, unknown: 0.4 }[String(status || 'unknown').toLowerCase()] ?? 0.4
}

export function rankExpertCandidates(candidates, { query = '', maxHourlyRate = null, availability = null } = {}) {
  const queryTokens = tokenize(query)
  return candidates
    .filter((candidate) => {
      if (availability && String(candidate.availability_status || '').toLowerCase() !== availability.toLowerCase()) return false
      if (maxHourlyRate && Number(candidate.hourly_rate ?? candidate.hourlyRate) > Number(maxHourlyRate)) return false
      return true
    })
    .map((candidate) => {
      const skill = scoreSkillMatch(candidate, queryTokens)
      const completionRate = clamp(candidate.completion_rate ?? candidate.completionRate)
      const outcomeHistory = clamp((Number(candidate.paid_minutes || candidate.paidMinutes || 0) / 600) * 0.5 + (Number(candidate.repeat_booking_rate ?? candidate.repeatBookingRate) || 0) * 0.5)
      const verification = String(candidate.verification_status || candidate.verificationStatus || '').toLowerCase() === 'verified' ? 1 : 0
      const components = {
        skillMatch: skill.score ?? skill,
        outcomeHistory,
        completionRate,
        responseLatency: scoreResponseLatency(candidate.response_latency_seconds ?? candidate.responseLatencySeconds),
        availability: scoreAvailability(candidate.availability_status ?? candidate.availabilityStatus),
        verification,
        rateFit: scoreRateFit(candidate, maxHourlyRate)
      }
      const score = Object.entries(SCORE_WEIGHTS).reduce((total, [key, weight]) => total + components[key] * weight, 0)
      const matchedFilters = [...(skill.matched || [])]
      if (components.verification) matchedFilters.push('verified profile')
      if (components.availability >= 0.8) matchedFilters.push('available soon')

      return {
        ...candidate,
        matchScore: Math.round(score * 10000) / 100,
        matchExplanation: {
          version: 1,
          weights: SCORE_WEIGHTS,
          components,
          matchedFilters,
          evidence: {
            profileId: candidate.id,
            verificationStatus: candidate.verification_status || candidate.verificationStatus || 'unverified',
            paidMinutes: Number(candidate.paid_minutes || candidate.paidMinutes || 0),
            completionRate,
            repeatBookingRate: Number(candidate.repeat_booking_rate ?? candidate.repeatBookingRate) || 0
          }
        }
      }
    })
    .sort((left, right) => right.matchScore - left.matchScore || String(left.id).localeCompare(String(right.id)))
}

export async function searchExperts({ client, query = '', filters = {}, limit = DEFAULT_LIMIT }) {
  if (!client || typeof client.query !== 'function') throw new DiscoveryServiceError('Database client with query method is required')
  const safeLimit = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT))
  const params = []
  const conditions = ['p.is_expert = true']

  if (filters.availability) {
    params.push(String(filters.availability).toLowerCase())
    conditions.push(`lower(p.availability_status) = $${params.length}`)
  }
  if (filters.language) {
    params.push(String(filters.language).toLowerCase())
    conditions.push(`EXISTS (SELECT 1 FROM unnest(p.languages) language WHERE lower(language) = $${params.length})`)
  }
  if (filters.timezone) {
    params.push(String(filters.timezone).toLowerCase())
    conditions.push(`lower(p.timezone) = $${params.length}`)
  }
  if (filters.maxHourlyRate) {
    params.push(Number(filters.maxHourlyRate))
    conditions.push(`p.hourly_rate <= $${params.length}`)
  }
  if (query.trim()) {
    params.push(`%${query.trim()}%`)
    conditions.push(`(
      lower(coalesce(p.name, '')) LIKE lower($${params.length}) OR
      lower(coalesce(p.bio, '')) LIKE lower($${params.length}) OR
      EXISTS (SELECT 1 FROM unnest(p.expertise) skill WHERE lower(skill) LIKE lower($${params.length}))
    )`)
  }

  params.push(safeLimit)
  const result = await client.query(`
    SELECT p.*, u.wallet_address
    FROM profiles p
    JOIN users u ON u.id = p.user_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY p.completion_rate DESC, p.repeat_booking_rate DESC, p.paid_minutes DESC, p.created_at ASC
    LIMIT $${params.length}
  `, params)

  return rankExpertCandidates(result.rows, filters).map((candidate) => ({
    id: candidate.id,
    wallet: candidate.wallet_address,
    name: candidate.name,
    bio: candidate.bio,
    hourlyRate: candidate.hourly_rate,
    expertise: candidate.expertise,
    availability: candidate.availability_status,
    timezone: candidate.timezone,
    languages: candidate.languages,
    verificationStatus: candidate.verification_status,
    matchScore: candidate.matchScore,
    matchExplanation: candidate.matchExplanation
  }))
}

export { SCORE_WEIGHTS }
