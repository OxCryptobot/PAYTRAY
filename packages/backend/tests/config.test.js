import { describe, expect, it } from 'vitest'
import config, { validateConfig } from '../lib/config.js'

describe('PayTray payment configuration safety', () => {
  it('defaults settlement to Base Sepolia and disables mainnet', () => {
    expect(config.payments.settlementChainId).toBe(84532)
    expect(config.payments.mainnetEnabled).toBe(false)
    expect(validateConfig()).toBe(true)
  })
})
