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

function diffStat(after, before, field) {
  return Math.max(0, nonnegativeInteger(after?.[field]) - nonnegativeInteger(before?.[field]))
}

export async function captureDatabaseSnapshot(client) {
  const [statsResult, waitResult] = await Promise.all([
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
    `)
  ])

  if (statsResult.rows.length !== 1) throw new Error('database observability returned no current-database statistics')
  return {
    sampledAt: new Date().toISOString(),
    stats: normalizeStats(statsResult.rows[0]),
    waitEvents: normalizeWaitEvents(waitResult.rows)
  }
}

async function acquireConnection(pool) {
  const startedAt = performance.now()
  const client = await pool.connect()
  return { client, elapsedMs: Number(Math.max(0, performance.now() - startedAt).toFixed(2)) }
}

export async function captureDatabaseTelemetrySample(pool) {
  const { client, elapsedMs } = await acquireConnection(pool)
  try {
    const snapshot = await captureDatabaseSnapshot(client)
    return { ...snapshot, connectionAcquisitionMs: elapsedMs }
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

  return {
    basis: DATABASE_TELEMETRY_BASIS,
    sampleCount: normalizedSamples.length,
    connectionAcquisitionMs: summarizeDurations(normalizedSamples.map((sample) => sample.connectionAcquisitionMs)),
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
  return {
    basis: DATABASE_TELEMETRY_BASIS,
    workerCount: summaries.length,
    sampleCount,
    connectionAcquisitionMs: {
      perWorker: connectionSummaries,
      max: connectionSummaries.length ? Math.max(...connectionSummaries.map((value) => nonnegativeNumber(value.max))) : null
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
