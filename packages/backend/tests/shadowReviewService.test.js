import { describe, expect, it } from 'vitest'
import { getShadowRunDetails, listShadowRuns, reviewShadowRun } from '../lib/shadowReviewService.js'

describe('shadow review service', () => {
  it('records an explicit reviewer decision without applying the candidate', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT * FROM ai_evaluation_runs')) return { rows: [{ id: 'run-1', status: 'shadow', reviewer_decision: 'pending' }] }
        if (sql.includes('UPDATE ai_evaluation_runs')) return { rows: [{ id: 'run-1', status: 'shadow', reviewer_decision: 'approved_pilot', reviewer_id: '0xoperator', model_name: 'candidate', model_version: 'v1', baseline_version: 'baseline-v1', rollback_target: 'baseline-v1' }] }
        if (sql.includes('INSERT INTO financial_audit_events')) return { rows: [{ id: 'audit-1' }] }
        if (sql.includes('INSERT INTO outbox_events')) return { rows: [{ id: 'outbox-1', aggregate_type: 'ai_evaluation_run', aggregate_id: 'run-1', event_type: 'ai.shadow_review_recorded', payload: {}, attempts: 0 }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const result = await reviewShadowRun({ client, runId: 'run-1', reviewerId: '0xoperator', decision: 'approved_pilot', notes: 'Reviewed CI evidence.' })
    expect(result.idempotentReplay).toBe(false)
    expect(result.applied).toBe(false)
    expect(result.auditEventId).toBe('audit-1')
    expect(result.promotionStatus).toBe('shadow_only')
    expect(result.authority).toBe('human_review_required')
    const auditCall = calls.find((call) => call.sql.includes('INSERT INTO financial_audit_events'))
    expect(auditCall.params[1]).toBe('shadow_review_recorded')
    expect(auditCall.params[3]).not.toContain('Reviewed CI evidence.')
    expect(JSON.parse(auditCall.params[3])).toMatchObject({ decision: 'approved_pilot', applied: false, promotionStatus: 'shadow_only', mutation: 'read_only' })
    const outboxCall = calls.find((call) => call.sql.includes('INSERT INTO outbox_events'))
    expect(outboxCall.params[2]).toBe('ai.shadow_review_recorded')
    expect(outboxCall.params[3]).not.toContain('Reviewed CI evidence.')
    expect(JSON.parse(outboxCall.params[3])).toMatchObject({ auditEventId: 'audit-1', decision: 'approved_pilot', applied: false, deliveryAuthority: 'durable_outbox_only' })
  })

  it('returns detailed shadow evidence with no applied decisions', async () => {
    const client = {
      async query(sql) {
        if (sql.includes('SELECT * FROM ai_evaluation_runs')) return { rows: [{ id: 'run-1', reviewer_decision: 'pending', status: 'shadow' }] }
        if (sql.includes('FROM ai_shadow_decisions')) return { rows: [{ id: 'decision-1', applied: false, human_review_status: 'not_reviewed' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const result = await getShadowRunDetails({ client, runId: 'run-1' })
    expect(result).toMatchObject({ decisionCount: 1, appliedDecisionCount: 0, promotionStatus: 'shadow_only', authority: 'human_review_required' })
  })

  it('lists bounded shadow runs for operator review', async () => {
    const client = {
      async query(sql, params) {
        expect(sql).toContain('FROM ai_evaluation_runs')
        expect(params).toEqual(['pending', 10])
        return { rows: [{ id: 'run-1', reviewer_decision: 'pending', rollback_target: 'weighted-explainable-v1' }] }
      }
    }
    const result = await listShadowRuns({ client, reviewerDecision: 'pending', limit: 10 })
    expect(result).toMatchObject({ reviewerDecision: 'pending', limit: 10, count: 1 })
    expect(result.runs[0].rollback_target).toBe('weighted-explainable-v1')
  })

  it('returns a replay for the same terminal decision and rejects conflicting decisions', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT * FROM ai_evaluation_runs')) return { rows: [{ id: 'run-1', status: 'shadow', reviewer_decision: 'rejected', model_name: 'candidate', model_version: 'v1', baseline_version: 'baseline-v1', rollback_target: 'baseline-v1' }] }
        if (sql.includes('INSERT INTO financial_audit_events')) return { rows: [{ id: 'audit-replay-1' }] }
        if (sql.includes('INSERT INTO outbox_events')) return { rows: [{ id: 'outbox-replay-1', aggregate_type: 'ai_evaluation_run', aggregate_id: 'run-1', event_type: 'ai.shadow_review_replayed', payload: {}, attempts: 0 }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const replay = await reviewShadowRun({ client, runId: 'run-1', reviewerId: '0xoperator', decision: 'rejected', notes: 'Replay verification.' })
    expect(replay.idempotentReplay).toBe(true)
    expect(replay.auditEventId).toBe('audit-replay-1')
    expect(replay.promotionStatus).toBe('shadow_only')
    expect(replay.authority).toBe('human_review_required')
    const replayOutboxCall = calls.find((call) => call.sql.includes('INSERT INTO outbox_events'))
    expect(replayOutboxCall.params[2]).toBe('ai.shadow_review_replayed')
    expect(JSON.parse(replayOutboxCall.params[3])).toMatchObject({ auditEventId: 'audit-replay-1', idempotentReplay: true, applied: false })
    await expect(reviewShadowRun({ client, runId: 'run-1', reviewerId: '0xoperator', decision: 'approved_pilot' })).rejects.toThrow('different review decision')
  })
})
