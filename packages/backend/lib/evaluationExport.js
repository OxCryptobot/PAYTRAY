import { createEvaluationExample } from './aiEvaluation.js'
import { saveEvaluationExample } from './aiEvaluationRepository.js'

function splitForTimestamp(timestamp, { trainBefore, validationBefore }) {
  const time = new Date(timestamp)
  if (time < new Date(trainBefore)) return 'train'
  if (time < new Date(validationBefore)) return 'validation'
  return 'test'
}

function labelForEvidence(row) {
  const verifiedEvents = Array.isArray(row.verified_events) ? row.verified_events : []
  const priority = ['repeat_booking', 'meeting_completed', 'paid_minutes_delivered', 'dispute_opened']
  const event = priority
    .map((eventType) => verifiedEvents.find((candidate) => candidate.event_type === eventType))
    .find(Boolean)
  if (!event) {
    return {
      labelType: 'completed',
      labelValue: 0,
      labelVerificationStatus: 'unverified',
      splitOverride: 'shadow',
      sourceEventIds: []
    }
  }
  const values = { repeat_booking: 3, meeting_completed: 2, paid_minutes_delivered: 1, dispute_opened: 0 }
  const labelTypes = { meeting_completed: 'completed', paid_minutes_delivered: 'payment_intent', repeat_booking: 'repeat_booking', dispute_opened: 'disputed' }
  return {
    labelType: labelTypes[event.event_type],
    labelValue: values[event.event_type],
    labelVerificationStatus: 'verified',
    splitOverride: null,
    sourceEventIds: [event.id]
  }
}

export function buildEvaluationExample(row, { datasetVersion, trainBefore, validationBefore }) {
  const label = labelForEvidence(row)
  const split = label.splitOverride || splitForTimestamp(row.observed_at, { trainBefore, validationBefore })
  return createEvaluationExample({
    datasetVersion,
    queryId: row.query_id,
    candidateProfileId: row.candidate_profile_id,
    engagementId: row.engagement_id,
    labelType: label.labelType,
    labelValue: label.labelValue,
    labelVerificationStatus: label.labelVerificationStatus,
    split,
    asOf: row.observed_at,
    sourceEventIds: label.sourceEventIds,
    provenance: {
      exportPolicy: datasetVersion,
      rankingVersion: row.ranking_version,
      impressionId: row.impression_id,
      baselineScore: row.baseline_score,
      verifiedEvidenceOnly: label.labelVerificationStatus === 'verified'
    }
  })
}

export async function exportRankingEvaluation({ client, datasetVersion = 'phase3-ranking-v1', trainBefore, validationBefore, asOf }) {
  const result = await client.query(`
    SELECT
      di.id AS impression_id,
      di.query_id,
      di.candidate_profile_id,
      di.engagement_id,
      di.observed_at,
      di.baseline_score,
      di.ranking_version,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('id', o.id, 'event_type', o.event_type)
          ORDER BY o.occurred_at
        ) FILTER (WHERE o.id IS NOT NULL AND o.verification_status = 'verified'),
        '[]'::jsonb
      ) AS verified_events
    FROM discovery_impressions di
    LEFT JOIN engagement_outcome_events o ON o.engagement_id = di.engagement_id
    WHERE di.observed_at <= $1::timestamp
    GROUP BY di.id
    ORDER BY di.query_id, di.rank_position
  `, [asOf])

  const examples = []
  for (const row of result.rows) {
    const example = buildEvaluationExample(row, { datasetVersion, trainBefore, validationBefore })
    await saveEvaluationExample(client, example)
    examples.push(example)
  }

  return {
    datasetVersion,
    asOf,
    trainBefore,
    validationBefore,
    exampleCount: examples.length,
    verifiedExampleCount: examples.filter((example) => example.labelVerificationStatus === 'verified').length,
    shadowExampleCount: examples.filter((example) => example.split === 'shadow').length,
    examples
  }
}

export { labelForEvidence, splitForTimestamp }
