import { describe, expect, it } from 'vitest'
import { buildLivenessReport, buildReadinessReport } from '../lib/health.js'

describe('Paytray process liveness', () => {
  it('reports process liveness without evaluating dependencies or granting authority', () => {
    expect(buildLivenessReport({ pid: 42, uptimeSeconds: 12.5, now: new Date('2026-08-18T22:00:00.000Z') })).toEqual({
      status: 'alive',
      live: true,
      authority: 'process_liveness_only',
      dependencyChecksPerformed: false,
      pid: 42,
      uptimeSeconds: 12.5,
      timestamp: '2026-08-18T22:00:00.000Z',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
  })

  it('normalizes invalid process metrics without failing liveness', () => {
    expect(buildLivenessReport({ pid: 0, uptimeSeconds: -1, now: new Date('2026-08-18T22:00:00.000Z') })).toMatchObject({ status: 'alive', live: true, pid: null, uptimeSeconds: 0, dependencyChecksPerformed: false })
  })
})

describe('Paytray dependency readiness', () => {
  const configured = {
    databaseStatus: 'ready',
    protocol: 'sablier-flow-v3',
    protocolContractAddress: '0x2222222222222222222222222222222222222222',
    enabledTokenCount: 1,
    verifierWorkerStatus: 'ready'
  }

  it('reports a fully configured production platform as ready', () => {
    const report = buildReadinessReport({ env: 'production', ...configured })

    expect(report.ready).toBe(true)
    expect(report.status).toBe('ready')
    expect(report.checks.database.ready).toBe(true)
    expect(report.checks.paymentProtocol.ready).toBe(true)
    expect(report).toMatchObject({ releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
  })

  it('keeps an unconfigured development process live but not payment-ready', () => {
    const report = buildReadinessReport({
      env: 'development',
      databaseStatus: 'unconfigured',
      protocol: 'sablier-flow-v3',
      protocolContractAddress: null,
      enabledTokenCount: 0,
      verifierWorkerStatus: 'not_configured'
    })

    expect(report.ready).toBe(false)
    expect(report.status).toBe('degraded')
    expect(report.checks.database.ready).toBe(true)
    expect(report.checks.paymentProtocol.ready).toBe(false)
    expect(report.checks.tokenRegistry.ready).toBe(false)
    expect(report).toMatchObject({ releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
  })

  it('does not treat an unconfigured production database as ready', () => {
    const report = buildReadinessReport({
      env: 'production',
      ...configured,
      databaseStatus: 'unconfigured'
    })

    expect(report.ready).toBe(false)
    expect(report.checks.database.ready).toBe(false)
  })
})
