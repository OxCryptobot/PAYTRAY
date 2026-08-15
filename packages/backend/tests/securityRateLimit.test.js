import { describe, expect, it } from 'vitest'
import config from '../lib/config.js'
import { checkRateLimit, getClientIP, rateLimitMap } from '../lib/security.js'

describe('bounded rate-limit state', () => {
  it('evicts expired entries before creating new state', () => {
    const originalMaxKeys = config.rateLimit.maxKeys
    try {
      config.rateLimit.maxKeys = 100
      rateLimitMap.clear()
      rateLimitMap.set('expired', { count: 1, resetAt: Date.now() - 1 })
      checkRateLimit('active', 10, 60000)
      expect(rateLimitMap.has('expired')).toBe(false)
      expect(rateLimitMap.has('active')).toBe(true)
    } finally {
      config.rateLimit.maxKeys = originalMaxKeys
      rateLimitMap.clear()
    }
  })

  it('uses the resolved request IP rather than raw forwarding headers', () => {
    expect(getClientIP({ ip: '198.51.100.10', socket: { remoteAddress: '127.0.0.1' } })).toBe('198.51.100.10')
    expect(getClientIP({ headers: { 'x-forwarded-for': '203.0.113.8' }, socket: { remoteAddress: '127.0.0.1' } })).toBe('127.0.0.1')
  })

  it('keeps the map at or below the configured key budget', () => {
    const originalMaxKeys = config.rateLimit.maxKeys
    try {
      config.rateLimit.maxKeys = 3
      rateLimitMap.clear()
      checkRateLimit('one', 10, 60000)
      checkRateLimit('two', 10, 60000)
      checkRateLimit('three', 10, 60000)
      checkRateLimit('four', 10, 60000)
      expect(rateLimitMap.size).toBeLessThanOrEqual(3)
      expect(rateLimitMap.has('four')).toBe(true)
    } finally {
      config.rateLimit.maxKeys = originalMaxKeys
      rateLimitMap.clear()
    }
  })
})
