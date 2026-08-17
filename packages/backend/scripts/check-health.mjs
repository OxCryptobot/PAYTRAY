const port = Number.parseInt(process.env.PORT || '3001', 10)
const healthUrl = process.env.HEALTHCHECK_URL || `http://127.0.0.1:${port}/health`

try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) })
  const payload = await response.json()
  if (!response.ok || payload.status !== 'healthy' || payload.service !== 'paytray-backend') {
    throw new Error(`health endpoint returned ${response.status} ${payload.status || 'unknown'}`)
  }
  console.log(JSON.stringify({ status: 'verified', url: healthUrl, service: payload.service, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
} catch (error) {
  console.error(JSON.stringify({ status: 'blocked', reason: error.message, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
  process.exitCode = 1
}
