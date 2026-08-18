import { describe, expect, it } from 'vitest'
import { verifyLiveness } from '../scripts/check-health.mjs'

function response(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload
    }
  }
}

describe('container liveness verifier', () => {
  it('accepts only the process-only liveness contract', async () => {
    await expect(verifyLiveness({
      healthUrl: 'http://127.0.0.1:3001/livez',
      fetchImpl: async () => response({ status: 'alive', live: true, authority: 'process_liveness_only' })
    })).resolves.toMatchObject({ status: 'verified', probe: 'liveness', authority: 'process_liveness_only', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
  })

  it('rejects readiness or legacy health responses as liveness', async () => {
    await expect(verifyLiveness({
      healthUrl: 'http://127.0.0.1:3001/health',
      fetchImpl: async () => response({ status: 'healthy', service: 'paytray-backend' })
    })).rejects.toThrow(/liveness endpoint returned/)
  })

  it('rejects non-200 responses and never grants authority', async () => {
    await expect(verifyLiveness({
      healthUrl: 'http://127.0.0.1:3001/livez',
      fetchImpl: async () => response({ status: 'alive', live: true, authority: 'process_liveness_only' }, { ok: false, status: 503 })
    })).rejects.toThrow(/liveness endpoint returned 503/)
  })
})
