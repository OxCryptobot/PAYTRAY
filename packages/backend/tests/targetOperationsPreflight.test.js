import { describe, expect, it } from 'vitest'
import config from '../lib/config.js'
import { buildTargetOperationsPreflight } from '../lib/targetOperationsPreflight.js'

function productionConfig() {
  const value = structuredClone(config)
  value.env = 'production'
  value.isProd = true
  value.isDev = false
  value.database.url = 'postgresql://paytray_ci:paytray_ci@127.0.0.1:5432/paytray_ci'
  value.jwt.secret = 'test-jwt-secret-not-for-deployment'
  value.payments.rpcUrl = 'https://sepolia.base.org'
  value.payments.protocolContractAddress = '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'
  value.payments.settlementChainId = 84532
  value.payments.mainnetEnabled = false
  value.payments.tokenRegistry = '[{"symbol":"USDC","chainId":84532,"address":"0x1111111111111111111111111111111111111111","decimals":6,"protocolContractAddress":"0xc1ba5a41936aaab0ff920446db556efe17fc1c5d","enabled":true}]'
  value.webhooks.signingSecret = 'test-webhook-signing-secret'
  value.verifierWorker.enabled = true
  value.outboxWorker.enabled = true
  value.housekeeping.idempotencyCleanupEnabled = true
  return value
}

describe('target operations preflight', () => {
  it('fails closed when target evidence and operational opt-ins are absent', () => {
    const report = buildTargetOperationsPreflight({ config })

    expect(report.status).toBe('blocked')
    expect(report.authority).toBe('configuration_preflight_only')
    expect(report.releaseEligible).toBe(false)
    expect(report.mutation).toBe('read_only')
    expect(report.settlementAuthority).toBe(false)
    expect(report.railwaySettings.status).toBe('settings_unavailable')
    expect(report.blockers.map((item) => item.name)).toEqual(expect.arrayContaining(['railwayTrialUrl', 'railwaySettings', 'verifierWorker', 'outboxWorker', 'idempotencyHousekeeping']))
  })

  it('reports ready only with matched redacted target settings and explicit operations', () => {
    const report = buildTargetOperationsPreflight({
      config: productionConfig(),
      env: {
        DEPLOYMENT_TARGET: 'railway-trial',
        RAILWAY_TRIAL_BASE_URL: 'https://trial.example.com',
        RAILWAY_TRIAL_ENVIRONMENT: 'production',
        RAILWAY_TRIAL_SETTLEMENT_CHAIN_ID: '84532',
        RAILWAY_TRIAL_PAYMENT_MAINNET_ENABLED: 'false',
        TARGET_VERIFIER_STATUS: 'fresh',
        TARGET_RECOVERY_STATUS: 'verified'
      }
    })

    expect(report.status).toBe('ready')
    expect(report.railwaySettings.status).toBe('match')
    expect(report.checks.every((item) => item.ready)).toBe(true)
    expect(report.verifierEvidence).toMatchObject({ status: 'fresh', targetEvidenceRequired: true, acceptedStatus: 'fresh' })
    expect(report.recoveryEvidence).toMatchObject({ status: 'verified', targetEvidenceRequired: true, acceptedStatus: 'verified' })
    expect(report.releaseEligible).toBe(false)
    expect(report.deploymentPerformed).toBe(false)
    expect(report.settlementMutationPerformed).toBe(false)
  })

  it('blocks an explicit Railway policy mismatch without exposing secrets', () => {
    const report = buildTargetOperationsPreflight({
      config: productionConfig(),
      env: {
        RAILWAY_TRIAL_BASE_URL: 'https://trial.example.com',
        RAILWAY_TRIAL_ENVIRONMENT: 'production',
        RAILWAY_TRIAL_SETTLEMENT_CHAIN_ID: '8453',
        RAILWAY_TRIAL_PAYMENT_MAINNET_ENABLED: 'false'
      }
    })

    expect(report.status).toBe('blocked')
    expect(report.railwaySettings.status).toBe('mismatch')
    expect(report.railwaySettings.checks.find((item) => item.name === 'settlementChainId')).toMatchObject({ expected: 84532, observed: 8453, status: 'mismatch' })
    expect(JSON.stringify(report)).not.toContain('test-webhook-signing-secret')
    expect(JSON.stringify(report)).not.toContain('test-jwt-secret-not-for-deployment')
  })
})
