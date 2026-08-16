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
    const releaseGatesBlocked = classifyOperationsCheck({
      name: 'release-gates',
      exitCode: 0,
      output: JSON.stringify({ status: 'operator_blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    })
    const bundleBlocked = classifyOperationsCheck({
      name: 'evidence-bundle',
      exitCode: 1,
      output: JSON.stringify({ status: 'blocked', authority: 'operator_evidence_bundle_export_only', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    })
    expect(blocked.state).toBe('operator_blocked')
    expect(blocked.expectedBlocked).toBe(true)
    const manifestBlocked = classifyOperationsCheck({
      name: 'release-manifest',
      exitCode: 1,
      output: JSON.stringify({ status: 'ok', manifest: { status: 'blocked' } })
    })
    const payloadBlocked = classifyOperationsCheck({
      name: 'release-payload',
      exitCode: 1,
      output: JSON.stringify({ status: 'ok', payload: { status: 'blocked' } })
    })
    const outboxBlocked = classifyOperationsCheck({
      name: 'outbox-health',
      exitCode: 1,
      output: JSON.stringify({ status: 'blocked' })
    })
    const approvalBlocked = classifyOperationsCheck({
      name: 'release-approval',
      exitCode: 1,
      output: JSON.stringify({ status: 'ok', artifact: { status: 'blocked' } })
    })
    const secretManagerBlocked = classifyOperationsCheck({
      name: 'secret-manager-custody',
      exitCode: 1,
      output: JSON.stringify({ status: 'blocked', reason: 'ephemeral secret-manager evidence is required', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    })
    expect(releaseGatesBlocked.state).toBe('operator_blocked')
    expect(releaseGatesBlocked.expectedBlocked).toBe(true)
    expect(bundleBlocked.state).toBe('operator_blocked')
    expect(bundleBlocked.expectedBlocked).toBe(true)
    expect(manifestBlocked.state).toBe('operator_blocked')
    expect(payloadBlocked.state).toBe('operator_blocked')
    expect(outboxBlocked.state).toBe('operator_blocked')
    expect(approvalBlocked.state).toBe('operator_blocked')
    expect(secretManagerBlocked.state).toBe('operator_blocked')
    expect(secretManagerBlocked.expectedBlocked).toBe(true)
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
    const strictSecretManager = classifyOperationsCheck({
      name: 'secret-manager-custody',
      exitCode: 1,
      strict: true,
      output: JSON.stringify({ status: 'blocked', reason: 'ephemeral secret-manager evidence is required' })
    })
    expect(normal.state).toBe('operator_blocked')
    expect(strict.state).toBe('failed')
    expect(strictSecretManager.state).toBe('failed')
  })

  it('builds an immutable report with no release or settlement authority', () => {
    const report = buildOperationsQualityReport({
      reportKind: 'release_gates',
      checks: [
        { name: 'quality-gate', state: 'passed', status: 'ok', exitCode: 0 },
        { name: 'target-operations', state: 'operator_blocked', status: 'blocked', reason: 'settings unavailable', exitCode: 1 }
      ]
    })
    expect(report.status).toBe('operator_blocked')
    expect(report.reportKind).toBe('release_gates')
    expect(report.passedCount).toBe(1)
    expect(report.operatorBlockerCount).toBe(1)
    expect(report.unexpectedFailureCount).toBe(0)
    expect(report.releaseEligible).toBe(false)
    expect(report.settlementAuthority).toBe(false)
    expect(report.mutation).toBe('read_only')
    expect(isOperationsQualityExitSuccess(report)).toBe(true)
  })
})
