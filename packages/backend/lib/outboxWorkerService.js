function positiveInteger(value, field, maximum) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`${field} must be an integer between 1 and ${maximum}`)
  return number
}

export function createOutboxWorker({ tick, intervalMs = 5000, maxIdlePolls = 0, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), logger = console }) {
  if (typeof tick !== 'function') throw new Error('tick is required')
  const boundedInterval = positiveInteger(intervalMs, 'intervalMs', 86400000)
  const boundedIdlePolls = Number(maxIdlePolls)
  if (!Number.isSafeInteger(boundedIdlePolls) || boundedIdlePolls < 0 || boundedIdlePolls > 1000000) throw new Error('maxIdlePolls must be an integer between 0 and 1000000')
  let stopped = false
  let running = false
  let idlePolls = 0

  async function runOnce() {
    if (running) return { status: 'skipped_concurrent_tick', settlementAuthority: false, mutation: 'read_only' }
    running = true
    try {
      const result = await tick()
      if (Number(result?.candidates || 0) === 0) idlePolls += 1
      else idlePolls = 0
      return { ...result, workerIdlePolls: idlePolls }
    } finally {
      running = false
    }
  }

  async function run({ signal } = {}) {
    stopped = false
    let lastResult = null
    while (!stopped && !signal?.aborted && (boundedIdlePolls === 0 || idlePolls < boundedIdlePolls)) {
      try {
        lastResult = await runOnce()
        if (lastResult?.status === 'attention') logger.warn?.('outbox worker attention', { failed: lastResult.failed, settlementAuthority: false })
      } catch (error) {
        lastResult = { status: 'attention', reason: String(error?.message || error), settlementAuthority: false, mutation: 'outbox_delivery_only' }
        logger.error?.('outbox worker tick failed', { reason: lastResult.reason, settlementAuthority: false })
      }
      if (!stopped && !signal?.aborted && (boundedIdlePolls === 0 || idlePolls < boundedIdlePolls)) await sleep(boundedInterval)
    }
    return { status: stopped || signal?.aborted ? 'stopped' : 'idle_limit_reached', lastResult, settlementAuthority: false, mutation: 'outbox_delivery_only' }
  }

  function stop() {
    stopped = true
  }

  return { run, runOnce, stop, get idlePolls() { return idlePolls } }
}
