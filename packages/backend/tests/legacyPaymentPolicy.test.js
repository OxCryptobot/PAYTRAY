import { describe, expect, it } from 'vitest'
import { assertLegacyPaymentMutationAllowed } from '../lib/payments/legacyPaymentPolicy.js'

describe('legacy payment mutation policy', () => {
  it('allows legacy routes in non-production test environments', () => {
    expect(assertLegacyPaymentMutationAllowed({ isProd: false })).toBe(true)
  })

  it('denies legacy in-memory payment mutations in production', () => {
    expect(() => assertLegacyPaymentMutationAllowed({ isProd: true }))
      .toThrow('Legacy in-memory payment mutations are disabled in production')
  })
})
