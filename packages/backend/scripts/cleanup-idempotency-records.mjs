import config from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { purgeExpiredIdempotencyRecords } from '../lib/idempotencyCleanupService.js'

const batchSize = process.env.IDEMPOTENCY_CLEANUP_BATCH_SIZE || 500
const now = process.env.IDEMPOTENCY_CLEANUP_NOW || new Date().toISOString()

try {
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('database is not ready')
  const result = await transaction((client) => purgeExpiredIdempotencyRecords({ client, batchSize, now }))
  console.log(JSON.stringify({
    success: true,
    database: config.database.url ? 'configured' : 'unconfigured',
    now: new Date(now).toISOString(),
    ...result
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    success: false,
    reason: error.message,
    authority: 'idempotency_housekeeping',
    mutation: 'none',
    settlementAuthority: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
} finally {
  await closeDatabase()
}
