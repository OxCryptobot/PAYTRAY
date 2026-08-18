import { fileURLToPath } from 'node:url'

export async function verifyLiveness({ healthUrl, fetchImpl = fetch } = {}) {
  if (typeof healthUrl !== 'string' || !healthUrl) throw new Error('healthUrl is required')
  const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(4000) })
  const payload = await response.json()
  if (!response.ok || payload.status !== 'alive' || payload.live !== true || payload.authority !== 'process_liveness_only') {
    throw new Error(`liveness endpoint returned ${response.status} ${payload.status || 'unknown'}`)
  }
  return {
    status: 'verified',
    probe: 'liveness',
    url: healthUrl,
    authority: payload.authority,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number.parseInt(process.env.PORT || '3001', 10)
  const healthUrl = process.env.HEALTHCHECK_URL || `http://127.0.0.1:${port}/livez`
  try {
    console.log(JSON.stringify(await verifyLiveness({ healthUrl }), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', probe: 'liveness', reason: error.message, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  }
}
