export function createRecoveryTiming({ clock = () => Date.now() } = {}) {
  const startedAtMs = clock()
  const phases = {}

  async function measure(name, operation) {
    const phaseStartedAtMs = clock()
    try {
      const result = await operation()
      phases[name] = {
        status: 'ok',
        durationMs: Math.max(0, clock() - phaseStartedAtMs)
      }
      return result
    } catch (error) {
      phases[name] = {
        status: 'blocked',
        durationMs: Math.max(0, clock() - phaseStartedAtMs)
      }
      throw error
    }
  }

  function snapshot({ rtoTargetMs = null } = {}) {
    const completedAtMs = clock()
    const targetMs = Number.isSafeInteger(rtoTargetMs) && rtoTargetMs > 0 ? rtoTargetMs : null
    const elapsedMs = Math.max(0, completedAtMs - startedAtMs)
    return {
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs,
      phases: { ...phases },
      rto: {
        targetMs,
        targetConfigured: targetMs !== null,
        withinTarget: targetMs === null ? null : elapsedMs <= targetMs,
        basis: targetMs === null ? 'not_configured' : 'operator_supplied'
      }
    }
  }

  return { measure, snapshot }
}
