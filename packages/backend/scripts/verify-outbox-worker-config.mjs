import config, { validateConfig } from '../lib/config.js'

try {
  validateConfig()
  if (!config.outboxWorker.enabled) throw new Error('OUTBOX_WORKER_ENABLED=true is required')
  if (!config.database.url) throw new Error('DATABASE_URL is required')
  if (!config.webhooks.signingSecret) throw new Error('WEBHOOK_SIGNING_SECRET is required')
  console.log(JSON.stringify({
    status: 'ready',
    worker: 'durable_outbox',
    enabled: true,
    pollIntervalMs: config.outboxWorker.pollIntervalMs,
    batchSize: config.outboxWorker.batchSize,
    leaseMs: config.outboxWorker.leaseMs,
    timeoutMs: config.outboxWorker.timeoutMs,
    maxAttempts: config.webhooks.maxAttempts,
    durableHookPersistence: 'postgresql_extension_hooks',
    deliverySemantics: 'at_least_once_bounded_retry',
    settlementAuthority: false,
    mutation: 'outbox_delivery_only',
    deploymentPerformed: false
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    worker: 'durable_outbox',
    reason: error.message,
    settlementAuthority: false,
    mutation: 'none',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
