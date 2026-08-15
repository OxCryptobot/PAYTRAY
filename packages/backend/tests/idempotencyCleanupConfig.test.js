import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const script = resolve(process.cwd(), 'scripts/verify-idempotency-cleanup-config.mjs')

function run(env) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
}

describe('idempotency cleanup schedule verifier', () => {
  it('fails closed until housekeeping is explicitly enabled', () => {
    const result = run({
      NODE_ENV: 'development',
      IDEMPOTENCY_CLEANUP_ENABLED: 'false',
      IDEMPOTENCY_CLEANUP_NOW: ''
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('IDEMPOTENCY_CLEANUP_ENABLED=true is required')
  })

  it('reports a bounded external-host schedule when explicitly enabled', () => {
    const result = run({
      NODE_ENV: 'production',
      JWT_SECRET: 'test-jwt-secret-not-for-deployment',
      DATABASE_URL: 'postgresql://paytray_ci:paytray_ci@127.0.0.1:5432/paytray_ci',
      SETTLEMENT_CHAIN_ID: '84532',
      PAYMENT_MAINNET_ENABLED: 'false',
      IDEMPOTENCY_CLEANUP_ENABLED: 'true',
      IDEMPOTENCY_CLEANUP_BATCH_SIZE: '500',
      IDEMPOTENCY_CLEANUP_INTERVAL_MS: '900000',
      IDEMPOTENCY_CLEANUP_NOW: ''
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'ready',
      job: 'idempotency_expiry_cleanup',
      schedule: 'external_host_scheduler',
      command: 'npm run backend:idempotency:cleanup:run',
      intervalMs: 900000,
      batchSize: 500,
      settlementAuthority: false,
      mutation: 'expired_idempotency_cleanup_only'
    })
  })
})
