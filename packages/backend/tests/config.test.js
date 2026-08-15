import { describe, expect, it } from 'vitest'
import config, { validateConfig } from '../lib/config.js'

describe('PayTray payment configuration safety', () => {
  it('defaults settlement to Base Sepolia and disables mainnet', () => {
    expect(config.payments.settlementChainId).toBe(84532)
    expect(config.payments.mainnetEnabled).toBe(false)
    expect(config.webhooks.retryBaseDelayMs).toBe(1000)
    expect(config.webhooks.signatureToleranceMs).toBe(300000)
    expect(config.webhooks.replayCacheMaxEntries).toBe(10000)
    expect(config.server.trustProxy).toBe(false)
    expect(config.server.requestBodyLimit).toBe('1mb')
    expect(config.outboxWorker.enabled).toBe(false)
    expect(config.outboxWorker.pollIntervalMs).toBe(5000)
    expect(config.outboxWorker.batchSize).toBe(25)
    expect(config.outboxWorker.leaseMs).toBe(120000)
    expect(config.housekeeping.idempotencyCleanupEnabled).toBe(false)
    expect(config.housekeeping.idempotencyCleanupBatchSize).toBe(500)
    expect(config.housekeeping.idempotencyCleanupIntervalMs).toBe(900000)
    expect(config.rateLimit.maxKeys).toBe(10000)
    expect(config.verifierWorker.enabled).toBe(false)
    expect(config.verifierWorker.pollIntervalMs).toBe(5000)
    expect(config.verifierWorker.maxBlockRange).toBe(2000)
    expect(config.verifierWorker.finalityConfirmations).toBe(10)
    expect(config.verifierWorker.verifierId).toBe('verifier-worker')
    expect(validateConfig()).toBe(true)
  })
})
