import config, { validateConfig } from '../lib/config.js'

try {
  validateConfig()
  if (!config.housekeeping.idempotencyCleanupEnabled) throw new Error('IDEMPOTENCY_CLEANUP_ENABLED=true is required')
  if (!config.database.url) throw new Error('DATABASE_URL is required')
  if (config.isProd && process.env.IDEMPOTENCY_CLEANUP_NOW) throw new Error('IDEMPOTENCY_CLEANUP_NOW is not allowed in production')

  console.log(JSON.stringify({
    status: 'ready',
    job: 'idempotency_expiry_cleanup',
    enabled: true,
    schedule: 'external_host_scheduler',
    command: 'npm run backend:idempotency:cleanup:run',
    intervalMs: config.housekeeping.idempotencyCleanupIntervalMs,
    batchSize: config.housekeeping.idempotencyCleanupBatchSize,
    database: 'postgresql_required',
    concurrency: 'safe_with_for_update_skip_locked',
    authority: 'idempotency_housekeeping',
    settlementAuthority: false,
    mutation: 'expired_idempotency_cleanup_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    job: 'idempotency_expiry_cleanup',
    reason: error.message,
    settlementAuthority: false,
    mutation: 'none',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
