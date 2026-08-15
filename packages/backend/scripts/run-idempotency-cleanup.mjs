import config, { validateConfig } from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { purgeExpiredIdempotencyRecords } from '../lib/idempotencyCleanupService.js'

try {
  validateConfig()
  if (!config.housekeeping.idempotencyCleanupEnabled) throw new Error('IDEMPOTENCY_CLEANUP_ENABLED=true is required')
  if (!config.database.url) throw new Error('DATABASE_URL is required')
  if (config.isProd && process.env.IDEMPOTENCY_CLEANUP_NOW) throw new Error('IDEMPOTENCY_CLEANUP_NOW is not allowed in production')

  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('database is not ready')
  const now = new Date().toISOString()
  const result = await transaction((client) => purgeExpiredIdempotencyRecords({
    client,
    batchSize: config.housekeeping.idempotencyCleanupBatchSize,
    now
  }))

  console.log(JSON.stringify({
    status: 'completed',
    job: 'idempotency_expiry_cleanup',
    schedule: 'external_host_scheduler',
    intervalMs: config.housekeeping.idempotencyCleanupIntervalMs,
    now,
    ...result,
    deploymentPerformed: false,
    settlementAuthority: false,
    settlementMutationPerformed: false
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    job: 'idempotency_expiry_cleanup',
    reason: error.message,
    schedule: 'external_host_scheduler',
    mutation: 'none',
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
} finally {
  await closeDatabase().catch(() => {})
}
