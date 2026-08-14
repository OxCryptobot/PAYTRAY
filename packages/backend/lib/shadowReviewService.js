import { ConflictError, NotFoundError, ValidationError } from './errors.js'
import { evaluateShadowQuality } from './shadowQualityGate.js'

export async function reviewShadowRun({ client, runId, reviewerId, decision, notes = null }) {
  if (!runId) throw new ValidationError('runId is required')
  if (!reviewerId) throw new ValidationError('reviewerId is required')
  if (!['approved_pilot', 'rejected'].includes(decision)) throw new ValidationError('decision must be approved_pilot or rejected')
  if (notes != null && typeof notes !== 'string') throw new ValidationError('notes must be a string')

  const current = await client.query('SELECT * FROM ai_evaluation_runs WHERE id = $1 FOR UPDATE', [runId])
  if (!current.rows[0]) throw new NotFoundError('Shadow evaluation run')
  const run = current.rows[0]
  if (run.status !== 'shadow') throw new ConflictError('Only shadow evaluation runs can be reviewed')
  if (run.reviewer_decision !== 'pending') {
    if (run.reviewer_decision === decision) return { run, idempotentReplay: true, applied: false }
    throw new ConflictError('Shadow evaluation run already has a different review decision')
  }

  const reviewed = await client.query(
    `UPDATE ai_evaluation_runs
     SET reviewer_decision = $1,
         reviewer_id = $2,
         reviewer_notes = $3,
         reviewed_at = CURRENT_TIMESTAMP
     WHERE id = $4 AND status = 'shadow' AND reviewer_decision = 'pending'
     RETURNING *`,
    [decision, String(reviewerId), notes, runId]
  )
  if (!reviewed.rows[0]) throw new ConflictError('Shadow evaluation review raced with another reviewer')
  return { run: reviewed.rows[0], idempotentReplay: false, applied: false }
}

export async function getShadowRunDetails({ client, runId }) {
  if (!runId) throw new ValidationError('runId is required')
  const runResult = await client.query('SELECT * FROM ai_evaluation_runs WHERE id = $1', [runId])
  if (!runResult.rows[0]) throw new NotFoundError('Shadow evaluation run')
  const decisions = await client.query(
    `SELECT id, task_type, entity_type, entity_id, model_version,
            input_hash, output, confidence, reason_codes, applied,
            human_review_status, latency_ms, cost_microunits, created_at
     FROM ai_shadow_decisions
     WHERE evaluation_run_id = $1
     ORDER BY created_at ASC, id ASC`,
    [runId]
  )
  return {
    run: runResult.rows[0],
    decisions: decisions.rows,
    decisionCount: decisions.rows.length,
    appliedDecisionCount: decisions.rows.filter((decision) => decision.applied).length,
    qualityGate: evaluateShadowQuality({
      metrics: runResult.rows[0].metrics || {},
      baselineVersion: runResult.rows[0].baseline_version,
      rollbackTarget: runResult.rows[0].rollback_target,
      reviewerDecision: runResult.rows[0].reviewer_decision
    }),
    promotionStatus: 'shadow_only',
    authority: 'human_review_required'
  }
}

export async function listShadowRuns({ client, reviewerDecision = 'pending', limit = 25 }) {
  if (!['pending', 'approved_pilot', 'rejected'].includes(reviewerDecision)) throw new ValidationError('reviewerDecision is unsupported')
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25))
  const result = await client.query(
    `SELECT id, task_type, model_name, model_version, baseline_version,
            dataset_version, time_split, metrics, status, reviewer_decision,
            reviewer_id, reviewer_notes, reviewed_at, rollback_target, limitations,
            created_at
     FROM ai_evaluation_runs
     WHERE reviewer_decision = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [reviewerDecision, safeLimit]
  )
  return { reviewerDecision, limit: safeLimit, runs: result.rows, count: result.rows.length }
}
