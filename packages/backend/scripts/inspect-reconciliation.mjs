import config from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { buildDurableReconciliationReport } from '../lib/payments/reconciliationService.js'

try {
  await initializeDatabase()
  const report = await transaction((client) => buildDurableReconciliationReport({ client }))
  console.log(JSON.stringify({ status: 'ok', databaseStatus: getDatabaseStatus(), protocol: config.payments.protocol, report }, null, 2))
} finally {
  await closeDatabase()
}
