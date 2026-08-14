import { describe, expect, it } from 'vitest'
import { getVerifierReadiness } from '../lib/payments/verifierReadiness.js'

const baseConfig = {
  env: 'production',
  payments: { settlementChainId: 84532, verifierCursorMaxAgeMs: 300000 }
}

function client(row) {
  return { async query() { return { rows: row ? [row] : [] } } }
}

describe('verifier readiness', () => {
  it('marks a recent durable cursor fresh', async () => {
    const readiness = await getVerifierReadiness({
      client: client({ chain_id: 84532, last_scanned_block: '100', updated_at: '2026-08-14T21:00:00.000Z' }),
      config: baseConfig,
      verifierWorkerStatus: 'configured',
      now: new Date('2026-08-14T21:04:00.000Z')
    })
    expect(readiness).toMatchObject({ ready: true, status: 'fresh', cursorAgeMs: 240000 })
  })

  it('blocks a stale or missing production cursor', async () => {
    const stale = await getVerifierReadiness({
      client: client({ chain_id: 84532, last_scanned_block: '100', updated_at: '2026-08-14T20:00:00.000Z' }),
      config: baseConfig,
      verifierWorkerStatus: 'configured',
      now: new Date('2026-08-14T21:00:00.000Z')
    })
    const missing = await getVerifierReadiness({
      client: client(null),
      config: baseConfig,
      verifierWorkerStatus: 'configured',
      now: new Date('2026-08-14T21:00:00.000Z')
    })
    expect(stale).toMatchObject({ ready: false, status: 'stale' })
    expect(missing).toMatchObject({ ready: false, status: 'missing' })
  })

  it('permits an unconfigured verifier only outside production', async () => {
    const readiness = await getVerifierReadiness({
      client: client(null),
      config: { env: 'test', payments: { settlementChainId: 84532, verifierCursorMaxAgeMs: 300000 } },
      verifierWorkerStatus: 'not_configured',
      env: 'test'
    })
    expect(readiness).toMatchObject({ ready: true, status: 'not_configured' })
  })
})
