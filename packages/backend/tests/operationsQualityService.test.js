import { describe, expect, it } from 'vitest'
import { buildOperationsQualityReport, classifyOperationsCheck, isOperationsQualityExitSuccess } from '../lib/operationsQualityService.js'

describe('operations quality service', () => {
  it('classifies expected operator gates separately from unexpected failures', () => {
    const blocked = classifyOperationsCheck({
      name: 'target-operations',
      exitCode: 1,
      output: JSON.stringify({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    })
    const failed = classifyOperationsCheck({
      name: 'sdk-contract',
      exitCode: 1,
      output: JSON.stringify({ status: 'failed', reason: 'contract drift' })
    })
    expect(blocked.state).toBe('operator_blocked')
    expect(blocked.expectedBlocked).toBe(true)
    expect(failed.state).toBe('failed')
    expect(failed.expectedBlocked).toBe(false)
  })

  it('accepts expected operator blockers in normal mode but fails strict mode', () => {
    const normal = classifyOperationsCheck({
      name: 'verifier-worker-config',
      exitCode: 1,
      output: JSON.stringify({ status: 'blocked', reason: 'explicit opt-in required' })
    })
    const strict = classifyOperationsCheck({
      name: 'verifier-worker-config',
      exitCode: 1,
      strict: true,
      output: JSON.stringify({ status: 'blocked', reason: 'explicit opt-in required' })
    })
    expect(normal.state).toBe('operator_blocked')
    expect(strict.state).toBe('failed')
  })

  it('builds an immutable report with no release or settlement authority', () => {
    const report = buildOperationsQualityReport({
      checks: [
        { name: 'quality-gate', state: 'passed', status: 'ok', exitCode: 0 },
        { name: 'target-operations', state: 'operator_blocked', status: 'blocked', reason: 'settings unavailable', exitCode: 1 }
      ]
    })
    expect(report.status).toBe('operator_blocked')
    expect(report.passedCount).toBe(1)
    expect(report.operatorBlockerCount).toBe(1)
    expect(report.unexpectedFailureCount).toBe(0)
    expect(report.releaseEligible).toBe(false)
    expect(report.settlementAuthority).toBe(false)
    expect(report.mutation).toBe('read_only')
    expect(isOperationsQualityExitSuccess(report)).toBe(true)
  })
})
