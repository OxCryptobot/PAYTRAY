import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import config from '../lib/config.js'
import { getOutboxHealth, listOutboxEvents } from '../lib/outboxDeliveryService.js'

let exitCode = 0
try {
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('outbox health requires a ready PostgreSQL database')
  const health = await transaction(async (client) => {
    const summary = await getOutboxHealth({ client, maxAttempts: config.webhooks.maxAttempts })
    const events = await listOutboxEvents({ client, limit: 25, maxAttempts: config.webhooks.maxAttempts })
    return { ...summary, events }
  })
  console.log(JSON.stringify(health, null, 2))
  exitCode = health.status === 'ok' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    authority: 'durable_outbox_delivery_health',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  exitCode = 1
} finally {
  await closeDatabase()
}

process.exitCode = exitCode
