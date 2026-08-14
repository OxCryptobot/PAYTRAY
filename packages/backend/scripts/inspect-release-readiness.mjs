import config from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { getReleaseReadiness } from '../lib/releaseReadiness.js'
import { parseTokenRegistry } from '../lib/payments/tokenRegistry.js'

try {
  await initializeDatabase()
  const readiness = await transaction((client) => getReleaseReadiness({
    client,
    config,
    databaseStatus: getDatabaseStatus(),
    enabledTokenCount: parseTokenRegistry(config.payments.tokenRegistry).list({ enabledOnly: true }).length,
    verifierWorkerStatus: 'not_configured'
  }))
  console.log(JSON.stringify({ status: 'ok', readiness }, null, 2))
} finally {
  await closeDatabase()
}
