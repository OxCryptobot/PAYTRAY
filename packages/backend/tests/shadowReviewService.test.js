import { describe, expect, it } from 'vitest'
import { getShadowRunDetails, listShadowRuns, reviewShadowRun } from '../lib/shadowReviewService.js'

describe('shadow review service', () => {
  it('records an explicit reviewer decision without applying the candidate', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT * FROM ai_evaluation_runs')) return { rows: [{ id: 'run-1', status: 'shadow', reviewer_decision: 'pending' }] }
        if (sql.includes('UPDATE ai_evaluation_runs')) return { rows: [{ id: 'run-1', status: 'shadow', reviewer_decision: 'approved_pilot', reviewer_id: '0xoperator' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const result = await reviewShadowRun({ client, runId: 'run-1', reviewerId: '0xoperator', decision: 'approved_pilot', notes: 'Reviewed CI evidence.' })
    expect(result.idempotentReplay).toBe(false)
    expect(result.applied).toBe(false)
    expect(calls.at(-1).params).toContain('approved_pilot')
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
    const client = {
      async query(sql) {
        if (sql.includes('SELECT * FROM ai_evaluation_runs')) return { rows: [{ id: 'run-1', status: 'shadow', reviewer_decision: 'rejected' }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const replay = await reviewShadowRun({ client, runId: 'run-1', reviewerId: '0xoperator', decision: 'rejected' })
    expect(replay.idempotentReplay).toBe(true)
    await expect(reviewShadowRun({ client, runId: 'run-1', reviewerId: '0xoperator', decision: 'approved_pilot' })).rejects.toThrow('different review decision')
  })
})
