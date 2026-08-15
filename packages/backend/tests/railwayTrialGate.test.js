import { describe, expect, it } from 'vitest'
import { compareRailwayTrialSettings, parseRailwayMetadataFromEnv, validateRailwayTrialUrl } from '../lib/railwayTrialGate.js'

describe('Railway trial gate', () => {
  it('accepts an HTTPS trial URL and rejects credentials or non-HTTPS URLs', () => {
    expect(validateRailwayTrialUrl('https://paytray-trial.up.railway.app/path')).toMatchObject({ configured: true, url: 'https://paytray-trial.up.railway.app' })
    expect(() => validateRailwayTrialUrl('http://paytray-trial.up.railway.app')).toThrow('must use HTTPS')
    expect(() => validateRailwayTrialUrl('https://user:pass@paytray-trial.up.railway.app')).toThrow('must not contain credentials')
  })

  it('reports matching and unavailable Railway settings without mutation', () => {
    const preflight = { environment: 'development', settlement: { chainId: 84532, mainnetEnabled: false } }
    const match = compareRailwayTrialSettings({ preflight, settings: { environment: 'development', settlementChainId: '84532', mainnetEnabled: 'false' } })
    const unavailable = compareRailwayTrialSettings({ preflight, settings: {} })
    expect(match).toMatchObject({ status: 'match', readOnly: true, deploymentPerformed: false })
    expect(unavailable.status).toBe('settings_unavailable')
  })

  it('normalizes complete non-secret project and service metadata', () => {
    const metadata = parseRailwayMetadataFromEnv({
      RAILWAY_PROJECT_NAME: 'heartfelt-liberation',
      RAILWAY_ENVIRONMENT_NAME: 'production',
      RAILWAY_WEB_SERVICE_STATUS: 'Offline',
      RAILWAY_WORKER_SERVICE_STATUS: 'running'
    })
    expect(metadata).toMatchObject({
      status: 'observed',
      source: 'operator_supplied_non_secret_metadata',
      projectName: 'heartfelt-liberation',
      environmentName: 'production',
      services: { web: 'offline', worker: 'running' },
      readOnly: true,
      deploymentPerformed: false
    })
  })

  it('keeps incomplete metadata unavailable and rejects unallowlisted service states', () => {
    expect(parseRailwayMetadataFromEnv({ RAILWAY_PROJECT_NAME: 'heartfelt-liberation' })).toMatchObject({ status: 'metadata_unavailable', source: 'not_supplied', services: { web: null, worker: null } })
    expect(() => parseRailwayMetadataFromEnv({ RAILWAY_PROJECT_NAME: 'heartfelt-liberation', RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_WEB_SERVICE_STATUS: 'secret', RAILWAY_WORKER_SERVICE_STATUS: 'offline' })).toThrow('recognized non-secret service status')
  })

  it('reports a configuration mismatch explicitly', () => {
    const result = compareRailwayTrialSettings({
      preflight: { environment: 'development', settlement: { chainId: 84532, mainnetEnabled: false } },
      settings: { environment: 'production', settlementChainId: '1', mainnetEnabled: 'true' }
    })
    expect(result.status).toBe('mismatch')
    expect(result.checks.filter((item) => item.status === 'mismatch')).toHaveLength(3)
  })
})
