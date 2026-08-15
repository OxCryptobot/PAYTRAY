import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const script = resolve(process.cwd(), 'scripts/verify-verifier-worker-config.mjs')

function run(env) {
  return spawnSync(process.execPath, [script], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })
}

describe('verifier worker configuration', () => {
  it('fails closed unless the worker is explicitly enabled', () => {
    const result = run({
      NODE_ENV: 'development',
      VERIFIER_WORKER_ENABLED: 'false'
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('VERIFIER_WORKER_ENABLED=true is required')
  })

  it('reports ready for an explicitly configured Base Sepolia worker', () => {
    const result = run({
      NODE_ENV: 'production',
      JWT_SECRET: 'test-jwt-secret-not-for-deployment',
      DATABASE_URL: 'postgresql://paytray_ci:paytray_ci@127.0.0.1:5432/paytray_ci',
      SETTLEMENT_CHAIN_ID: '84532',
      PAYMENT_MAINNET_ENABLED: 'false',
      PAYMENT_RPC_URL: 'https://sepolia.base.org',
      PAYMENT_STREAM_PROTOCOL_CONTRACT: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d',
      PAYMENT_TOKEN_REGISTRY: '[{"symbol":"USDC","chainId":84532,"address":"0x1111111111111111111111111111111111111111","decimals":6,"protocolContractAddress":"0xc1ba5a41936aaab0ff920446db556efe17fc1c5d","enabled":true}]',
      VERIFIER_WORKER_ENABLED: 'true',
      VERIFIER_WORKER_POLL_INTERVAL_MS: '5000',
      VERIFIER_WORKER_MAX_BLOCK_RANGE: '2000',
      VERIFIER_WORKER_ID: 'base-sepolia-verifier'
    })

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'ready',
      worker: 'base_sepolia_verifier',
      chainId: 84532,
      rpcTransport: 'https_required',
      maxBlockRange: 2000,
      verifierId: 'base-sepolia-verifier',
      enabledTokenCount: 1,
      settlementAuthority: false,
      mutation: 'verifier_projection_only'
    })
  })
})
