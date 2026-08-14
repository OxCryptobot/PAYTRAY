import { describe, expect, it } from 'vitest'
import { assertPaymentTransition, PAYMENT_EVENT_SOURCES } from '../lib/payments/paymentLifecycle.js'

describe('payment lifecycle authority', () => {
  it('does not expose mock adapters as a financial event source', () => {
    expect(PAYMENT_EVENT_SOURCES).not.toContain('mock_adapter')
    expect(() => assertPaymentTransition({
      from: 'chain_included',
      to: 'chain_finalized',
      source: 'mock_adapter'
    })).toThrow('Unknown payment event source')
  })

  it('keeps verifier ownership for settlement finality', () => {
    expect(assertPaymentTransition({
      from: 'chain_included',
      to: 'chain_finalized',
      source: 'verifier'
    })).toBe(true)
    expect(assertPaymentTransition({
      from: 'chain_finalized',
      to: 'ledger_reflected',
      source: 'ledger_worker'
    })).toBe(true)
  })
})
