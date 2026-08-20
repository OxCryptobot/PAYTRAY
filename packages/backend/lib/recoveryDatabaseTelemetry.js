const DATABASE_TELEMETRY_BASIS = 'postgresql_observability'
const MAX_WAIT_EVENT_ROWS = 32
const DEFAULT_INTERVAL_MS = 25
const DEFAULT_MAX_SAMPLES = 120

function nonnegativeNumber(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

function nonnegativeInteger(value, fallback = 0) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return Number((sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)).toFixed(2))
}

function summarizeDurations(values) {
  const normalized = values.filter((value) => Number.isFinite(value) && value >= 0)
  return {
    count: normalized.length,
    p50: percentile(normalized, 0.5),
    p95: percentile(normalized, 0.95),
    p99: percentile(normalized, 0.99),
    max: normalized.length ? Math.max(...normalized) : null,
    mean: normalized.length ? Number((normalized.reduce((sum, value) => sum + value, 0) / normalized.length).toFixed(2)) : null
  }
}

function safeWaitEventValue(value, fallback) {
  const normalized = String(value ?? fallback)
  return normalized.length > 80 ? normalized.slice(0, 80) : normalized
}

function normalizeWaitEvents(rows = []) {
  return rows.slice(0, MAX_WAIT_EVENT_ROWS).map((row) => ({
    waitEventType: safeWaitEventValue(row.wait_event_type, 'none'),
    waitEvent: safeWaitEventValue(row.wait_event, 'none'),
    state: safeWaitEventValue(row.state, 'unknown'),
    count: nonnegativeInteger(row.count)
  }))
}

function normalizeStats(row) {
  if (!row) return null
  return {
    databaseSizeBytes: nonnegativeInteger(row.database_size_bytes),
    tempBytes: nonnegativeInteger(row.temp_bytes),
    tempFiles: nonnegativeInteger(row.temp_files),
    blocksRead: nonnegativeInteger(row.blocks_read),
    blocksHit: nonnegativeInteger(row.blocks_hit)
  }
}

function normalizeWal(row) {
  if (!row) return null
  return {
    walRecords: nonnegativeInteger(row.wal_records),
    walFpi: nonnegativeInteger(row.wal_fpi),
    walBytes: nonnegativeNumber(row.wal_bytes),
    walBuffersFull: nonnegativeInteger(row.wal_buffers_full),
    walWrite: nonnegativeInteger(row.wal_write),
    walSync: nonnegativeInteger(row.wal_sync),
    walWriteTimeMs: nonnegativeNumber(row.wal_write_time),
    walSyncTimeMs: nonnegativeNumber(row.wal_sync_time)
  }
}

function normalizeBgwriter(row) {
  if (!row) return null
  return {
    buffersCheckpoint: nonnegativeInteger(row.buffers_checkpoint),
    buffersClean: nonnegativeInteger(row.buffers_clean),
    maxwrittenClean: nonnegativeInteger(row.maxwritten_clean),
    buffersBackend: nonnegativeInteger(row.buffers_backend),
    buffersBackendFsync: nonnegativeInteger(row.buffers_backend_fsync),
    checkpointWriteTimeMs: nonnegativeNumber(row.checkpoint_write_time),
    checkpointSyncTimeMs: nonnegativeNumber(row.checkpoint_sync_time)
  }
}

function normalizeIo(row) {
  if (!row) return null
  return {
    ioReads: nonnegativeInteger(row.io_reads),
    ioWrites: nonnegativeInteger(row.io_writes),
    ioWriteTimeMs: nonnegativeNumber(row.io_write_time),
    ioFsyncs: nonnegativeInteger(row.io_fsyncs),
    ioFsyncTimeMs: nonnegativeNumber(row.io_fsync_time),
    ioExtends: nonnegativeInteger(row.io_extends),
    ioExtendTimeMs: nonnegativeNumber(row.io_extend_time)
  }
}

function diffStat(after, before, field) {
  return Math.max(0, nonnegativeNumber(after?.[field]) - nonnegativeNumber(before?.[field]))
}

function diffCounters(after, before, fields) {
  return Object.fromEntries(fields.map((field) => [field, diffStat(after, before, field)]))
}

function poolPressureSnapshot(pool) {
  const totalCount = nonnegativeInteger(pool?.totalCount)
  const idleCount = Math.min(totalCount, nonnegativeInteger(pool?.idleCount))
  const waitingCount = nonnegativeInteger(pool?.waitingCount)
  const configuredMax = nonnegativeInteger(pool?.options?.max ?? pool?.max)
  const maxConnections = configuredMax || Math.max(totalCount, 1)
  const activeCount = Math.max(0, totalCount - idleCount)
  return {
    totalCount,
    idleCount,
    activeCount,
    waitingCount,
    maxConnections,
    utilizationRatio: Number(Math.min(1, activeCount / maxConnections).toFixed(4))
  }
}

function summarizePoolPressure(values) {
  const normalized = values.filter(Boolean)
  if (normalized.length === 0) {
    return {
      sampleCount: 0,
      maxTotalCount: 0,
      maxActiveCount: 0,
      maxWaitingCount: 0,
      meanWaitingCount: 0,
      maxUtilizationRatio: 0,
      meanUtilizationRatio: 0
    }
  }
  return {
    sampleCount: normalized.length,
    maxTotalCount: Math.max(...normalized.map((value) => nonnegativeInteger(value.totalCount))),
    maxActiveCount: Math.max(...normalized.map((value) => nonnegativeInteger(value.activeCount))),
    maxWaitingCount: Math.max(...normalized.map((value) => nonnegativeInteger(value.waitingCount))),
    meanWaitingCount: Number((normalized.reduce((sum, value) => sum + nonnegativeInteger(value.waitingCount), 0) / normalized.length).toFixed(3)),
    maxUtilizationRatio: Number(Math.max(...normalized.map((value) => nonnegativeNumber(value.utilizationRatio))).toFixed(4)),
    meanUtilizationRatio: Number((normalized.reduce((sum, value) => sum + nonnegativeNumber(value.utilizationRatio), 0) / normalized.length).toFixed(4))
  }
}

function summarizeCounterTelemetry(samples, field, fields, basis) {
  const first = samples.find((sample) => sample?.[field])?.[field] || null
  const last = [...samples].reverse().find((sample) => sample?.[field])?.[field] || first
  return {
    basis,
    before: first,
    after: last,
    deltas: diffCounters(last, first, fields)
  }
}

export async function captureDatabaseSnapshot(client) {
  const [statsResult, waitResult, walResult, bgwriterResult, ioResult] = await Promise.all([
    client.query(`
      SELECT
        pg_database_size(current_database())::bigint AS database_size_bytes,
        COALESCE(stats.temp_bytes, 0)::bigint AS temp_bytes,
        COALESCE(stats.temp_files, 0)::bigint AS temp_files,
        COALESCE(stats.blks_read, 0)::bigint AS blocks_read,
        COALESCE(stats.blks_hit, 0)::bigint AS blocks_hit
      FROM pg_database AS database_record
      LEFT JOIN pg_stat_database AS stats ON stats.datname = database_record.datname
      WHERE database_record.datname = current_database()
    `),
    client.query(`
      SELECT
        COALESCE(wait_event_type, 'none') AS wait_event_type,
        COALESCE(wait_event, 'none') AS wait_event,
        COALESCE(state, 'unknown') AS state,
        COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database()
      GROUP BY wait_event_type, wait_event, state
      ORDER BY count DESC, wait_event_type, wait_event, state
      LIMIT ${MAX_WAIT_EVENT_ROWS}
    `),
    client.query(`
      SELECT
        COALESCE(wal_records, 0)::bigint AS wal_records,
        COALESCE(wal_fpi, 0)::bigint AS wal_fpi,
        COALESCE(wal_bytes, 0)::numeric AS wal_bytes,
        COALESCE(wal_buffers_full, 0)::bigint AS wal_buffers_full,
        COALESCE(wal_write, 0)::bigint AS wal_write,
        COALESCE(wal_sync, 0)::bigint AS wal_sync,
        COALESCE(wal_write_time, 0)::double precision AS wal_write_time,
        COALESCE(wal_sync_time, 0)::double precision AS wal_sync_time
      FROM pg_stat_wal
    `),
    client.query(`
      SELECT
        COALESCE(buffers_checkpoint, 0)::bigint AS buffers_checkpoint,
        COALESCE(buffers_clean, 0)::bigint AS buffers_clean,
        COALESCE(maxwritten_clean, 0)::bigint AS maxwritten_clean,
        COALESCE(buffers_backend, 0)::bigint AS buffers_backend,
        COALESCE(buffers_backend_fsync, 0)::bigint AS buffers_backend_fsync,
        COALESCE(checkpoint_write_time, 0)::double precision AS checkpoint_write_time,
        COALESCE(checkpoint_sync_time, 0)::double precision AS checkpoint_sync_time
      FROM pg_stat_bgwriter
    `),
    client.query(`
      SELECT
        COALESCE(SUM(reads), 0)::bigint AS io_reads,
        COALESCE(SUM(writes), 0)::bigint AS io_writes,
        COALESCE(SUM(write_time), 0)::double precision AS io_write_time,
        COALESCE(SUM(fsyncs), 0)::bigint AS io_fsyncs,
        COALESCE(SUM(fsync_time), 0)::double precision AS io_fsync_time,
        COALESCE(SUM(extends), 0)::bigint AS io_extends,
        COALESCE(SUM(extend_time), 0)::double precision AS io_extend_time
      FROM pg_stat_io
    `)
  ])

  if (statsResult.rows.length !== 1) throw new Error('database observability returned no current-database statistics')
  return {
    sampledAt: new Date().toISOString(),
    stats: normalizeStats(statsResult.rows[0]),
    waitEvents: normalizeWaitEvents(waitResult.rows),
    wal: normalizeWal(walResult.rows[0]),
    bgwriter: normalizeBgwriter(bgwriterResult.rows[0]),
    io: normalizeIo(ioResult.rows[0])
  }
}

async function acquireConnection(pool) {
  const startedAt = performance.now()
  const client = await pool.connect()
  return { client, elapsedMs: Number(Math.max(0, performance.now() - startedAt).toFixed(2)) }
}

export async function captureDatabaseTelemetrySample(pool) {
  const poolBefore = poolPressureSnapshot(pool)
  const { client, elapsedMs } = await acquireConnection(pool)
  try {
    const snapshotQueryStartedAt = performance.now()
    const snapshot = await captureDatabaseSnapshot(client)
    const snapshotQueryElapsedMs = Number(Math.max(0, performance.now() - snapshotQueryStartedAt).toFixed(3))
    return { ...snapshot, snapshotQueryElapsedMs, connectionAcquisitionMs: elapsedMs, poolPressure: { before: poolBefore, after: poolPressureSnapshot(pool) } }
  } finally {
    client.release()
  }
}

export function summarizeDatabaseTelemetry(samples, { operationElapsedMs = null, errors = [] } = {}) {
  const normalizedSamples = samples.filter((sample) => sample && sample.stats && Array.isArray(sample.waitEvents))
  const first = normalizedSamples[0]
  const last = normalizedSamples[normalizedSamples.length - 1] || first
  const waitEventCounts = new Map()
  for (const sample of normalizedSamples) {
    for (const event of sample.waitEvents) {
      const key = `${event.waitEventType}|${event.waitEvent}|${event.state}`
      const current = waitEventCounts.get(key) || {
        waitEventType: event.waitEventType,
        waitEvent: event.waitEvent,
        state: event.state,
        observations: 0,
        observedBackendCount: 0
      }
      current.observations += 1
      current.observedBackendCount += nonnegativeInteger(event.count)
      waitEventCounts.set(key, current)
    }
  }
  const before = first?.stats || null
  const after = last?.stats || before
  const elapsedMs = operationElapsedMs === null
    ? (first && last ? Math.max(0, Date.parse(last.sampledAt) - Date.parse(first.sampledAt)) : null)
    : nonnegativeNumber(operationElapsedMs)
  const tempBytesDelta = diffStat(after, before, 'tempBytes')
  const tempFilesDelta = diffStat(after, before, 'tempFiles')
  const blocksReadDelta = diffStat(after, before, 'blocksRead')
  const blocksHitDelta = diffStat(after, before, 'blocksHit')
  const snapshotQueryElapsedMs = summarizeDurations(normalizedSamples.map((sample) => sample.snapshotQueryElapsedMs))
  const wal = summarizeCounterTelemetry(normalizedSamples, 'wal', ['walRecords', 'walFpi', 'walBytes', 'walBuffersFull', 'walWrite', 'walSync', 'walWriteTimeMs', 'walSyncTimeMs'], 'pg_stat_wal')
  const bgwriter = summarizeCounterTelemetry(normalizedSamples, 'bgwriter', ['buffersCheckpoint', 'buffersClean', 'maxwrittenClean', 'buffersBackend', 'buffersBackendFsync', 'checkpointWriteTimeMs', 'checkpointSyncTimeMs'], 'pg_stat_bgwriter')
  const io = summarizeCounterTelemetry(normalizedSamples, 'io', ['ioReads', 'ioWrites', 'ioWriteTimeMs', 'ioFsyncs', 'ioFsyncTimeMs', 'ioExtends', 'ioExtendTimeMs'], 'pg_stat_io')
  const poolSamples = normalizedSamples.flatMap((sample) => [sample.poolPressure?.before, sample.poolPressure?.after]).filter(Boolean)

  return {
    basis: DATABASE_TELEMETRY_BASIS,
    sampleCount: normalizedSamples.length,
    connectionAcquisitionMs: summarizeDurations(normalizedSamples.map((sample) => sample.connectionAcquisitionMs)),
    snapshotQueryElapsedMs,
    poolPressure: summarizePoolPressure(poolSamples),
    waitEvents: {
      sampleCount: normalizedSamples.length,
      observations: [...waitEventCounts.values()].sort((a, b) => b.observedBackendCount - a.observedBackendCount)
    },
    databaseStats: {
      before,
      after,
      deltas: {
        databaseSizeBytes: diffStat(after, before, 'databaseSizeBytes'),
        tempBytes: tempBytesDelta,
        tempFiles: tempFilesDelta,
        blocksRead: blocksReadDelta,
        blocksHit: blocksHitDelta
      }
    },
    wal,
    bgwriter,
    io,
    temporaryStorage: {
      tempBytesDelta,
      tempFilesDelta,
      throughputBytesPerSecond: elapsedMs && elapsedMs > 0 ? Number((tempBytesDelta / (elapsedMs / 1000)).toFixed(2)) : 0,
      operationElapsedMs: elapsedMs
    },
    errors: errors.map((error) => String(error).slice(0, 200))
  }
}

export function createDatabaseTelemetryCollector({ pool, intervalMs = DEFAULT_INTERVAL_MS, maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new Error('database telemetry requires a PostgreSQL pool')
  if (!Number.isInteger(intervalMs) || intervalMs < 5 || intervalMs > 1000) throw new Error('database telemetry interval must be an integer between 5 and 1000 ms')
  if (!Number.isInteger(maxSamples) || maxSamples < 2 || maxSamples > 1000) throw new Error('database telemetry max samples must be an integer between 2 and 1000')

  const samples = []
  const errors = []
  let timer = null
  let inFlight = false
  let stopped = false

  async function sample() {
    if (stopped || inFlight || samples.length >= maxSamples) return
    inFlight = true
    try {
      samples.push(await captureDatabaseTelemetrySample(pool))
    } catch (error) {
      errors.push(error.message)
    } finally {
      inFlight = false
    }
  }

  async function start() {
    await sample()
    timer = setInterval(() => { void sample() }, intervalMs)
  }

  async function stop(operationElapsedMs = null) {
    if (timer) clearInterval(timer)
    timer = null
    await sample()
    stopped = true
    const result = summarizeDatabaseTelemetry(samples, { operationElapsedMs, errors })
    if (result.sampleCount < 2) throw new Error('database observability collected fewer than two snapshots')
    if (result.errors.length > 0) throw new Error(`database observability sampling failed: ${result.errors[0]}`)
    return result
  }

  return { start, stop }
}

function mergeCounterDeltas(summaries, field, fields, basis) {
  return {
    basis,
    deltas: Object.fromEntries(fields.map((metric) => [metric, summaries.reduce((sum, value) => sum + nonnegativeNumber(value?.[field]?.deltas?.[metric]), 0)]))
  }
}

export function mergeDatabaseTelemetry(values) {
  const summaries = values.filter((value) => value && value.basis === DATABASE_TELEMETRY_BASIS)
  const waitEventCounts = new Map()
  let tempBytesDelta = 0
  let tempFilesDelta = 0
  let operationElapsedMs = 0
  let sampleCount = 0
  const errors = []
  for (const summary of summaries) {
    sampleCount += nonnegativeInteger(summary.sampleCount)
    tempBytesDelta += nonnegativeInteger(summary.temporaryStorage?.tempBytesDelta)
    tempFilesDelta += nonnegativeInteger(summary.temporaryStorage?.tempFilesDelta)
    operationElapsedMs += nonnegativeNumber(summary.temporaryStorage?.operationElapsedMs)
    errors.push(...(Array.isArray(summary.errors) ? summary.errors : []))
    for (const event of summary.waitEvents?.observations || []) {
      const key = `${event.waitEventType}|${event.waitEvent}|${event.state}`
      const current = waitEventCounts.get(key) || {
        waitEventType: event.waitEventType,
        waitEvent: event.waitEvent,
        state: event.state,
        observations: 0,
        observedBackendCount: 0
      }
      current.observations += nonnegativeInteger(event.observations)
      current.observedBackendCount += nonnegativeInteger(event.observedBackendCount)
      waitEventCounts.set(key, current)
    }
  }
  const connectionSummaries = summaries.map((summary) => summary.connectionAcquisitionMs).filter(Boolean)
  const snapshotQuerySummaries = summaries.map((summary) => summary.snapshotQueryElapsedMs).filter(Boolean)
  const poolSummaries = summaries.map((summary) => summary.poolPressure).filter(Boolean)
  return {
    basis: DATABASE_TELEMETRY_BASIS,
    workerCount: summaries.length,
    sampleCount,
    connectionAcquisitionMs: {
      perWorker: connectionSummaries,
      max: connectionSummaries.length ? Math.max(...connectionSummaries.map((value) => nonnegativeNumber(value.max))) : null
    },
    poolPressure: {
      sampleCount: poolSummaries.reduce((sum, value) => sum + nonnegativeInteger(value.sampleCount), 0),
      maxTotalCount: poolSummaries.length ? Math.max(...poolSummaries.map((value) => nonnegativeInteger(value.maxTotalCount))) : 0,
      maxWaitingCount: poolSummaries.length ? Math.max(...poolSummaries.map((value) => nonnegativeInteger(value.maxWaitingCount))) : 0,
      maxActiveCount: poolSummaries.length ? Math.max(...poolSummaries.map((value) => nonnegativeInteger(value.maxActiveCount))) : 0,
      maxUtilizationRatio: poolSummaries.length ? Math.max(...poolSummaries.map((value) => nonnegativeNumber(value.maxUtilizationRatio))) : 0,
      meanWaitingCount: poolSummaries.length ? Number((poolSummaries.reduce((sum, value) => sum + nonnegativeNumber(value.meanWaitingCount), 0) / poolSummaries.length).toFixed(3)) : 0,
      meanUtilizationRatio: poolSummaries.length ? Number((poolSummaries.reduce((sum, value) => sum + nonnegativeNumber(value.meanUtilizationRatio), 0) / poolSummaries.length).toFixed(4)) : 0,
      perWorker: poolSummaries
    },
    waitEvents: {
      sampleCount,
      observations: [...waitEventCounts.values()].sort((a, b) => b.observedBackendCount - a.observedBackendCount)
    },
    databaseStats: {
      deltas: {
        tempBytes: tempBytesDelta,
        tempFiles: tempFilesDelta
      }
    },
    snapshotQueryElapsedMs: {
      ...summarizeDurations(snapshotQuerySummaries.map((summary) => summary.max)),
      perWorker: snapshotQuerySummaries
    },
    wal: mergeCounterDeltas(summaries, 'wal', ['walRecords', 'walFpi', 'walBytes', 'walBuffersFull', 'walWrite', 'walSync', 'walWriteTimeMs', 'walSyncTimeMs'], 'pg_stat_wal'),
    bgwriter: mergeCounterDeltas(summaries, 'bgwriter', ['buffersCheckpoint', 'buffersClean', 'maxwrittenClean', 'buffersBackend', 'buffersBackendFsync', 'checkpointWriteTimeMs', 'checkpointSyncTimeMs'], 'pg_stat_bgwriter'),
    io: mergeCounterDeltas(summaries, 'io', ['ioReads', 'ioWrites', 'ioWriteTimeMs', 'ioFsyncs', 'ioFsyncTimeMs', 'ioExtends', 'ioExtendTimeMs'], 'pg_stat_io'),
    temporaryStorage: {
      tempBytesDelta,
      tempFilesDelta,
      operationElapsedMs,
      throughputBytesPerSecond: operationElapsedMs > 0 ? Number((tempBytesDelta / (operationElapsedMs / 1000)).toFixed(2)) : 0
    },
    errors: errors.map((error) => String(error).slice(0, 200))
  }
}

export const databaseTelemetryConstants = {
  basis: DATABASE_TELEMETRY_BASIS,
  maxWaitEventRows: MAX_WAIT_EVENT_ROWS,
  defaultIntervalMs: DEFAULT_INTERVAL_MS,
  defaultMaxSamples: DEFAULT_MAX_SAMPLES
}
