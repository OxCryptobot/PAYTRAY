import { describe, it, expect } from 'vitest'
import { ChainVerifier } from '../lib/chainVerifier.js'
import { embed, cosine, canonicalize, semanticSkillScore } from '../lib/semantic.js'

const HASH = `0x${'a'.repeat(64)}`

function provider({ receipt, head = 100 }) {
  return { getTransactionReceipt: async () => receipt, getBlockNumber: async () => head }
}

describe('ChainVerifier', () => {
  it('rejects malformed hashes', async () => {
    const v = new ChainVerifier(provider({ receipt: null }))
    expect((await v.verify('nope')).status).toBe('invalid')
  })

  it('reports not_found, reverted, included and confirmed', async () => {
    expect((await new ChainVerifier(provider({ receipt: null })).verify(HASH)).status).toBe('not_found')
    expect((await new ChainVerifier(provider({ receipt: { status: 0, blockNumber: 99 } })).verify(HASH)).status).toBe('reverted')
    const receipt = { status: 1, blockNumber: 99, blockHash: '0x1' }
    expect((await new ChainVerifier(provider({ receipt, head: 100 }), { minConfirmations: 3 }).verify(HASH)).status).toBe('included')
    const confirmed = await new ChainVerifier(provider({ receipt, head: 101 }), { minConfirmations: 3 }).verify(HASH)
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.confirmations).toBe(3)
  })

  it('flags unexpected recipients', async () => {
    const receipt = { status: 1, blockNumber: 99, to: '0xAbc' }
    const result = await new ChainVerifier(provider({ receipt })).verify(HASH, { expectedTo: '0xdef' })
    expect(result.status).toBe('mismatch')
  })

  it('detects reorgs by missing receipt or changed block hash', async () => {
    expect((await new ChainVerifier(provider({ receipt: null })).detectReorg(HASH, '0x1')).reorged).toBe(true)
    const changed = new ChainVerifier(provider({ receipt: { blockHash: '0x2' } }))
    expect((await changed.detectReorg(HASH, '0x1')).reorged).toBe(true)
    const same = new ChainVerifier(provider({ receipt: { blockHash: '0x1' } }))
    expect((await same.detectReorg(HASH, '0x1')).reorged).toBe(false)
  })
})

describe('semantic matcher', () => {
  it('canonicalizes synonyms', () => {
    expect(canonicalize('Smart Contract developer')).toContain('solidity')
  })

  it('scores synonyms and typos above unrelated terms', () => {
    const synonym = cosine(embed('smart contract'), embed('solidity'))
    const typo = cosine(embed('solidty'), embed('solidity'))
    const unrelated = cosine(embed('figma'), embed('kubernetes'))
    expect(synonym).toBeGreaterThan(0.9)
    expect(typo).toBeGreaterThan(unrelated)
    expect(cosine(embed(''), embed('rust'))).toBe(0)
  })

  it('finds the best matching expertise term for a profile', () => {
    const profile = { expertise: ['solidity', 'defi'], bio: 'audits' }
    expect(semanticSkillScore('smart contract', profile)).toBeGreaterThan(semanticSkillScore('figma', profile))
  })
})

describe('rate limiter memory bounds', () => {
  it('sweeps expired windows without evicting active keys', async () => {
    const { rateLimitMap, sweepRateLimits } = await import('../lib/security.js')
    rateLimitMap.clear()
    rateLimitMap.set('expired', { count: 1, resetAt: 1000 })
    for (let i = 0; i < 5; i += 1) rateLimitMap.set(`live${i}`, { count: 1, resetAt: 10000 + i })
    sweepRateLimits(5000)
    expect(rateLimitMap.has('expired')).toBe(false)
    expect(rateLimitMap.size).toBe(5)
    expect(rateLimitMap.has('live4')).toBe(true)
    rateLimitMap.clear()
  })

  it('rejects new keys at capacity without resetting existing windows', async () => {
    const { checkRateLimit, rateLimitMap, RATE_LIMIT_MAX_KEYS } = await import('../lib/security.js')
    rateLimitMap.clear()
    const resetAt = Date.now() + 60000
    for (let i = 0; i < RATE_LIMIT_MAX_KEYS; i += 1) rateLimitMap.set(`live${i}`, { count: 1, resetAt })
    expect(() => checkRateLimit('new-key', 1, 60000)).toThrow('capacity exceeded')
    expect(rateLimitMap.size).toBe(RATE_LIMIT_MAX_KEYS)
    expect(() => checkRateLimit('live0', 1, 60000)).toThrow('Rate limit exceeded')
    rateLimitMap.clear()
  })
})

import { migrateLearningTrust } from '../lib/learningTrust.js'

describe('learning trust migration', () => {
  it('resets learners and demotes legacy trusted labels', () => {
    const out = migrateLearningTrust({ learner: { x: 1 }, riskLearner: { y: 1 }, reputationEvents: [{ trusted: true }], paymentStreams: [['1', { riskLearned: true }]] })
    expect(out.learner).toBeNull()
    expect(out.reputationEvents[0].trusted).toBe(false)
    expect(out.paymentStreams[0][1].riskLearned).toBe(false)
    expect(migrateLearningTrust(out)).toBe(out)
  })
})
