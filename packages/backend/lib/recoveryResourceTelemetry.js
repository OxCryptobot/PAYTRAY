const RESOURCE_FIELDS = [
  'userCpuTimeUs',
  'systemCpuTimeUs',
  'fsReadOps',
  'fsWriteOps',
  'voluntaryContextSwitches',
  'involuntaryContextSwitches'
]

function nonnegativeInteger(value, fallback = 0) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback
}

export function captureRecoveryResourceUsage({ memoryUsage = () => process.memoryUsage(), resourceUsage = () => process.resourceUsage() } = {}) {
  const memory = memoryUsage()
  const resource = resourceUsage()
  return {
    rssBytes: nonnegativeInteger(memory.rss),
    heapUsedBytes: nonnegativeInteger(memory.heapUsed),
    externalBytes: nonnegativeInteger(memory.external),
    arrayBuffersBytes: nonnegativeInteger(memory.arrayBuffers),
    userCpuTimeUs: nonnegativeInteger(resource.userCPUTime),
    systemCpuTimeUs: nonnegativeInteger(resource.systemCPUTime),
    maxRssKb: nonnegativeInteger(resource.maxRSS),
    fsReadOps: nonnegativeInteger(resource.fsRead),
    fsWriteOps: nonnegativeInteger(resource.fsWrite),
    voluntaryContextSwitches: nonnegativeInteger(resource.voluntaryContextSwitches),
    involuntaryContextSwitches: nonnegativeInteger(resource.involuntaryContextSwitches)
  }
}

function delta(start, end, field) {
  return Math.max(0, nonnegativeInteger(end[field]) - nonnegativeInteger(start[field]))
}

export function diffRecoveryResourceUsage(start, end) {
  return {
    basis: 'node_process_resource_usage',
    rssBytes: nonnegativeInteger(end.rssBytes),
    rssDeltaBytes: delta(start, end, 'rssBytes'),
    heapUsedBytes: nonnegativeInteger(end.heapUsedBytes),
    externalBytes: nonnegativeInteger(end.externalBytes),
    arrayBuffersBytes: nonnegativeInteger(end.arrayBuffersBytes),
    peakRssKb: nonnegativeInteger(end.maxRssKb),
    userCpuTimeUs: delta(start, end, 'userCpuTimeUs'),
    systemCpuTimeUs: delta(start, end, 'systemCpuTimeUs'),
    fsReadOps: delta(start, end, 'fsReadOps'),
    fsWriteOps: delta(start, end, 'fsWriteOps'),
    voluntaryContextSwitches: delta(start, end, 'voluntaryContextSwitches'),
    involuntaryContextSwitches: delta(start, end, 'involuntaryContextSwitches')
  }
}

export function createRecoveryResourceTelemetry({ capture = captureRecoveryResourceUsage } = {}) {
  const started = capture()
  const phases = {}

  async function measure(name, operation) {
    const phaseStarted = capture()
    try {
      return await operation()
    } finally {
      phases[name] = diffRecoveryResourceUsage(phaseStarted, capture())
    }
  }

  function snapshot() {
    return {
      basis: 'node_process_resource_usage',
      process: diffRecoveryResourceUsage(started, capture()),
      phases: { ...phases }
    }
  }

  return { measure, snapshot }
}

export function summarizeChildProcessUsage(values) {
  const samples = values.filter((value) => value && value.basis === 'gnu_time_child_process')
  return {
    basis: 'gnu_time_child_process',
    sampleCount: samples.length,
    totals: {
      userCpuTimeMs: Number(samples.reduce((sum, value) => sum + Number(value.userCpuTimeMs || 0), 0).toFixed(2)),
      systemCpuTimeMs: Number(samples.reduce((sum, value) => sum + Number(value.systemCpuTimeMs || 0), 0).toFixed(2)),
      elapsedMs: Number(samples.reduce((sum, value) => sum + Number(value.elapsedMs || 0), 0).toFixed(2))
    },
    peakRssKb: samples.length ? Math.max(...samples.map((value) => nonnegativeInteger(value.peakRssKb))) : null,
    perWorkerPeakRssKb: samples.map((value) => nonnegativeInteger(value.peakRssKb))
  }
}

export function summarizeRecoveryResourceUsage(values) {
  const samples = values.filter((value) => value && value.basis === 'node_process_resource_usage')
  const totals = Object.fromEntries(RESOURCE_FIELDS.map((field) => [field, samples.reduce((sum, value) => sum + nonnegativeInteger(value[field]), 0)]))
  return {
    basis: 'node_process_resource_usage',
    sampleCount: samples.length,
    totals,
    memory: {
      peakRssKb: samples.length ? Math.max(...samples.map((value) => nonnegativeInteger(value.peakRssKb))) : null,
      maxRssBytes: samples.length ? Math.max(...samples.map((value) => nonnegativeInteger(value.rssBytes))) : null,
      maxHeapUsedBytes: samples.length ? Math.max(...samples.map((value) => nonnegativeInteger(value.heapUsedBytes))) : null
    },
    perWorkerPeakRssKb: samples.map((value) => nonnegativeInteger(value.peakRssKb)),
    perWorkerRssBytes: samples.map((value) => nonnegativeInteger(value.rssBytes)),
    perWorkerHeapUsedBytes: samples.map((value) => nonnegativeInteger(value.heapUsedBytes))
  }
}
