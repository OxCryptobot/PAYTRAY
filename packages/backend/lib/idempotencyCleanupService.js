import { ValidationError } from './errors.js'

const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 5000

function normalizeBatchSize(value = DEFAULT_BATCH_SIZE) {
  const batchSize = Number(value)
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new ValidationError(`batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}`)
  }
  return batchSize
}

function normalizeNow(value = new Date()) {
  const now = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(now.getTime())) throw new ValidationError('now must be a valid timestamp')
  return now
}

export async function purgeExpiredIdempotencyRecords({ client, now = new Date(), batchSize = DEFAULT_BATCH_SIZE }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const normalizedNow = normalizeNow(now)
  const normalizedBatchSize = normalizeBatchSize(batchSize)
  const result = await client.query(
    `WITH expired AS (
       SELECT id
       FROM idempotency_records
       WHERE expires_at <= $1
       ORDER BY expires_at ASC, id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM idempotency_records records
     USING expired
     WHERE records.id = expired.id
     RETURNING records.id`,
    [normalizedNow.toISOString(), normalizedBatchSize]
  )
  return {
    deletedCount: result.rows.length,
    batchSize: normalizedBatchSize,
    hasMore: result.rows.length === normalizedBatchSize,
    authority: 'idempotency_housekeeping',
    mutation: 'expired_idempotency_cleanup',
    settlementAuthority: false,
    settlementMutationPerformed: false
  }
}

export { DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE }
