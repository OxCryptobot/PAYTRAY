import config, { validateConfig } from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { listExtensionHooks } from '../lib/extensionHookService.js'
import { processDurableOutbox } from '../lib/outboxProcessorService.js'
import { createOutboxWorker } from '../lib/outboxWorkerService.js'

function output(payload) {
  console.log(JSON.stringify(payload, null, 2))
}

let worker
let exitCode = 0

try {
  validateConfig()
  if (!config.outboxWorker.enabled) throw new Error('OUTBOX_WORKER_ENABLED=true is required to start the production outbox worker')
  if (!config.webhooks.signingSecret) throw new Error('WEBHOOK_SIGNING_SECRET is required to start the production outbox worker')
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('outbox worker requires a ready PostgreSQL database')

  const tick = () => transaction(async (client) => processDurableOutbox({
    client,
    hooks: await listExtensionHooks({ client }),
    dryRun: false,
    limit: config.outboxWorker.batchSize,
    leaseMs: config.outboxWorker.leaseMs,
    maxAttempts: config.webhooks.maxAttempts,
    retryBaseDelayMs: config.webhooks.retryBaseDelayMs,
    timeoutMs: config.outboxWorker.timeoutMs,
    signingSecret: config.webhooks.signingSecret,
    signatureToleranceMs: config.webhooks.signatureToleranceMs
  }))

  worker = createOutboxWorker({
    tick,
    intervalMs: config.outboxWorker.pollIntervalMs,
    maxIdlePolls: config.outboxWorker.maxIdlePolls
  })
  const stop = () => worker.stop()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  output({
    status: 'started',
    worker: 'durable_outbox',
    pollIntervalMs: config.outboxWorker.pollIntervalMs,
    batchSize: config.outboxWorker.batchSize,
    leaseMs: config.outboxWorker.leaseMs,
    maxAttempts: config.webhooks.maxAttempts,
    deliverySemantics: 'at_least_once_bounded_retry',
    settlementAuthority: false,
    deploymentPerformed: false
  })
  const result = await worker.run()
  output(result)
  exitCode = result.lastResult?.status === 'attention' ? 1 : 0
} catch (error) {
  output({
    status: 'blocked',
    worker: 'durable_outbox',
    reason: error.message,
    settlementAuthority: false,
    mutation: 'none',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  })
  exitCode = 1
} finally {
  await closeDatabase()
  process.exitCode = exitCode
}
