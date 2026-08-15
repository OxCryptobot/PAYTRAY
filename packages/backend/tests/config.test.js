import { describe, expect, it } from 'vitest'
import config, { validateConfig } from '../lib/config.js'

describe('PayTray payment configuration safety', () => {
  it('defaults settlement to Base Sepolia and disables mainnet', () => {
    expect(config.payments.settlementChainId).toBe(84532)
    expect(config.payments.mainnetEnabled).toBe(false)
    expect(config.webhooks.retryBaseDelayMs).toBe(1000)
    expect(config.webhooks.signatureToleranceMs).toBe(300000)
    expect(config.webhooks.replayCacheMaxEntries).toBe(10000)
    expect(validateConfig()).toBe(true)
  })
})
