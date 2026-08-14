import { describe, expect, it } from 'vitest'
import { buildDeploymentPreflight } from '../lib/deploymentPreflight.js'

const base = {
  env: 'production',
  database: { url: 'postgresql://db' },
  jwt: { secret: 'secret' },
  payments: {
    rpcUrl: 'https://rpc.example',
    protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d',
    tokenRegistry: JSON.stringify([{ chainId: 84532, address: '0x1111111111111111111111111111111111111111', decimals: 6, symbol: 'USDC', enabled: true }]),
    settlementChainId: 84532,
    protocol: 'sablier-flow-v3',
    mainnetEnabled: false,
    verifierCursorMaxAgeMs: 300000
  },
  webhooks: { signingSecret: 'webhook-secret' }
}

describe('deployment preflight', () => {
  it('passes a complete production testnet configuration without deploying', () => {
    const report = buildDeploymentPreflight({ config: base, deploymentTarget: 'railway-trial' })
    expect(report).toMatchObject({ ready: true, deploymentTarget: 'railway-trial', authority: 'configuration_preflight_only', mutation: 'read_only', deploymentPerformed: false })
  })

  it('blocks production when the verifier RPC or token registry is unsafe', () => {
    const report = buildDeploymentPreflight({
      config: { ...base, payments: { ...base.payments, rpcUrl: 'http://rpc.example', tokenRegistry: '[]' } }
    })
    expect(report.ready).toBe(false)
    expect(report.checks.find((item) => item.name === 'rpc').ready).toBe(false)
    expect(report.checks.find((item) => item.name === 'tokenRegistry').ready).toBe(false)
  })
})
