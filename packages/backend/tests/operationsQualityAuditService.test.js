import { describe, expect, it, vi } from 'vitest'
import { buildOperationsQualityAuditRecord, listOperationsQualityRuns, recordOperationsQualityRun } from '../lib/operationsQualityAuditService.js'

const report = {
  status: 'operator_blocked',
  strict: false,
  checkCount: 2,
  passedCount: 1,
  operatorBlockerCount: 1,
  unexpectedFailureCount: 0,
  checks: [
    {
      name: 'target-operations',
      state: 'operator_blocked',
      exitCode: 1,
      status: 'blocked',
      expectedBlocked: true,
      reason: 'operator evidence is required',
      authority: 'target_operations_preflight',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      secret: 'must not persist'
    },
    {
      name: 'quality-gate',
      state: 'passed',
      exitCode: 0,
      status: 'passed',
      expectedBlocked: false,
      reason: 'check passed'
    }
  ],
  operatorBlockers: [{ name: 'target-operations', status: 'blocked', reason: 'operator evidence is required' }],
  unexpectedFailures: [],
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false,
  generatedAt: '2026-08-15T20:00:00.000Z'
}

describe('operations quality audit service', () => {
  it('persists a safe canonical report without raw output or authority', () => {
    const record = buildOperationsQualityAuditRecord({
      report,
      runId: 'run-1',
      startedAt: '2026-08-15T19:59:00.000Z',
      completedAt: '2026-08-15T20:00:00.000Z'
    })

    expect(record).toMatchObject({
      runId: 'run-1',
      status: 'operator_blocked',
      checkCount: 2,
      passedCount: 1,
      operatorBlockerCount: 1,
      unexpectedFailureCount: 0,
      authority: 'operations_quality_audit',
      mutation: 'read_only',
      releaseEligible: false,
      settlementAuthority: false,
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
    expect(record.report.checks[0]).not.toHaveProperty('secret')
    expect(record.report.releaseEligible).toBe(false)
    expect(record.report.settlementAuthority).toBe(false)
    expect(record.reportHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('inserts a run once and reports replay without duplicating it', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: 'row-1', run_id: 'run-1' }] })
        .mockResolvedValueOnce({ rows: [] })
    }

    const first = await recordOperationsQualityRun({ client, report, runId: 'run-1' })
    const replay = await recordOperationsQualityRun({ client, report, runId: 'run-1' })

    expect(first).toMatchObject({ idempotentReplay: false, runId: 'run-1', mutation: 'read_only', settlementAuthority: false })
    expect(replay).toMatchObject({ idempotentReplay: true, runId: 'run-1', mutation: 'read_only', settlementAuthority: false })
    expect(client.query).toHaveBeenCalledTimes(2)
    expect(client.query.mock.calls[0][0]).toContain('ON CONFLICT (run_id) DO NOTHING')
    expect(client.query.mock.calls[0][1][7]).toContain('"releaseEligible":false')
  })

  it('lists bounded summary rows without returning report payloads', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ run_id: 'run-1', report_hash: 'a'.repeat(64) }] }) }
    const result = await listOperationsQualityRuns({ client, limit: 1000, status: 'operator_blocked' })

    expect(result).toMatchObject({ status: 'ok', count: 1, authority: 'operations_quality_audit', mutation: 'read_only', releaseEligible: false, settlementAuthority: false })
    expect(result.runs[0]).not.toHaveProperty('report')
    expect(client.query.mock.calls[0][1]).toEqual(['operator_blocked', 100])
  })
})
