export async function saveFeatureSnapshot(client, snapshot) {
  const result = await client.query(
    `INSERT INTO ai_feature_snapshots (
      entity_type, entity_id, feature_version, as_of, features,
      source_event_ids, source_hash, privacy_class, retention_until
    ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::uuid[], $7, $8, $9)
    ON CONFLICT (entity_type, entity_id, feature_version, as_of)
    DO UPDATE SET features = EXCLUDED.features,
                  source_event_ids = EXCLUDED.source_event_ids,
                  source_hash = EXCLUDED.source_hash,
                  retention_until = EXCLUDED.retention_until
    RETURNING *`,
    [snapshot.entityType, snapshot.entityId, snapshot.featureVersion, snapshot.asOf, JSON.stringify(snapshot.features), snapshot.sourceEventIds, snapshot.sourceHash, snapshot.privacyClass, snapshot.retentionUntil]
  )
  return result.rows[0]
}

export async function saveEvaluationExample(client, example) {
  const result = await client.query(
    `INSERT INTO ai_evaluation_examples (
      dataset_version, query_id, candidate_profile_id, engagement_id,
      label_type, label_value, label_verification_status, split,
      as_of, source_event_ids, provenance
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11::jsonb)
    ON CONFLICT (dataset_version, query_id, candidate_profile_id, split)
    DO UPDATE SET label_value = EXCLUDED.label_value,
                  label_verification_status = EXCLUDED.label_verification_status,
                  source_event_ids = EXCLUDED.source_event_ids,
                  provenance = EXCLUDED.provenance
    RETURNING *`,
    [example.datasetVersion, example.queryId, example.candidateProfileId, example.engagementId, example.labelType, example.labelValue, example.labelVerificationStatus, example.split, example.asOf, example.sourceEventIds, JSON.stringify(example.provenance)]
  )
  return result.rows[0]
}

export async function saveEvaluationRun(client, run) {
  const result = await client.query(
    `INSERT INTO ai_evaluation_runs (
      task_type, model_name, model_version, baseline_version,
      dataset_version, time_split, metrics, subgroup_metrics,
      status, reviewer_decision, rollback_target, limitations
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
    RETURNING *`,
    [run.taskType, run.modelName, run.modelVersion, run.baselineVersion, run.datasetVersion, JSON.stringify(run.timeSplit), JSON.stringify(run.metrics || {}), JSON.stringify(run.subgroupMetrics || {}), run.status || 'created', run.reviewerDecision || 'pending', run.rollbackTarget || null, run.limitations || null]
  )
  return result.rows[0]
}

export async function saveShadowDecision(client, decision) {
  const result = await client.query(
    `INSERT INTO ai_shadow_decisions (
      evaluation_run_id, task_type, entity_type, entity_id,
      model_version, input_hash, output, confidence, reason_codes,
      applied, human_review_status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, false, 'not_reviewed')
    RETURNING *`,
    [decision.evaluationRunId, decision.taskType, decision.entityType, decision.entityId, decision.modelVersion, decision.inputHash, JSON.stringify(decision.output), decision.confidence, JSON.stringify(decision.reasonCodes)]
  )
  return result.rows[0]
}
