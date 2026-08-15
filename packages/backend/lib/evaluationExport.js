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
      rankPosition: row.rank_position == null ? null : Number(row.rank_position),
      selected: row.selected === true,
      verifiedEvidenceOnly: label.labelVerificationStatus === 'verified',
      lineage: {
        status: row.lineage_status || (row.engagement_id ? 'engaged_no_outcome' : 'unlinked'),
        engagementId: row.engagement_id,
        outcomeEventCount: Array.isArray(row.outcome_events) ? row.outcome_events.length : 0,
        verifiedOutcomeCount: Array.isArray(row.verified_events) ? row.verified_events.length : 0,
        sourceOutcomeIds: (Array.isArray(row.outcome_events) ? row.outcome_events : []).map((event) => event.id).filter(Boolean)
      },
      rawContentIncluded: false
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
      di.rank_position,
      di.selected,
      di.observed_at,
      di.baseline_score,
      di.ranking_version,
      CASE
        WHEN di.engagement_id IS NULL THEN 'unlinked'
        WHEN COUNT(o.id) FILTER (WHERE o.verification_status = 'verified') > 0 THEN 'verified_outcome'
        WHEN COUNT(o.id) FILTER (WHERE o.verification_status = 'unverified') > 0 THEN 'unverified_outcome'
        WHEN COUNT(o.id) FILTER (WHERE o.verification_status = 'rejected') > 0 THEN 'rejected_outcome'
        ELSE 'engaged_no_outcome'
      END AS lineage_status,
      COALESCE(
        jsonb_agg(
          jsonb_build_object('id', o.id, 'event_type', o.event_type, 'verification_status', o.verification_status)
          ORDER BY o.occurred_at
        ) FILTER (WHERE o.id IS NOT NULL),
        '[]'::jsonb
      ) AS outcome_events,
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
    lineageCoverage: {
      verifiedOutcomeCount: examples.filter((example) => example.provenance.lineage.status === 'verified_outcome').length,
      unverifiedOutcomeCount: examples.filter((example) => example.provenance.lineage.status === 'unverified_outcome').length,
      rejectedOutcomeCount: examples.filter((example) => example.provenance.lineage.status === 'rejected_outcome').length,
      unlinkedImpressionCount: examples.filter((example) => example.provenance.lineage.status === 'unlinked').length,
      rawContentIncluded: false
    },
    authority: 'verified_outcome_lineage',
    mutation: 'durable_evaluation_export',
    examples
  }
}

export { labelForEvidence, splitForTimestamp }
