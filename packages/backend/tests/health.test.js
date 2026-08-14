import { describe, expect, it } from 'vitest'
import { buildReadinessReport } from '../lib/health.js'

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
