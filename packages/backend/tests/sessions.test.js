import { describe, it, expect } from 'vitest'
import { SessionStore } from '../lib/sessions.js'

describe('SessionStore', () => {
  it('rotates jti and revokes the family on reuse', () => {
    const store = new SessionStore()
    const { sid, jti } = store.create('u', '0xabc', ['a'])
    const first = store.rotate(sid, jti)
    expect(first.ok).toBe(true)
    expect(first.jti).not.toBe(jti)
    expect(store.rotate(sid, jti)).toEqual({ ok: false, reason: 'reuse_detected' })
    expect(store.isActive(sid)).toBe(false)
    expect(store.rotate(sid, first.jti).reason).toBe('revoked')
  })

  it('handles unknown sessions, revoke and revokeAll', () => {
    const store = new SessionStore()
    expect(store.rotate('nope', 'x').reason).toBe('unknown_session')
    const one = store.create('u', '0xabc', [])
    const two = store.create('u', '0xabc', [])
    store.create('u2', '0xdef', [])
    expect(store.revoke(one.sid)).toBe(true)
    expect(store.revokeAllForWallet('0xabc')).toBe(1)
    expect(store.isActive(two.sid)).toBe(false)
    expect(store.revoke('missing')).toBe(false)
  })

  it('prunes idle families and round-trips through JSON', () => {
    const store = new SessionStore()
    const { sid } = store.create('u', '0xabc', [], 1000)
    const clone = new SessionStore()
    clone.restore(JSON.parse(JSON.stringify(store.toJSON())))
    expect(clone.isActive(sid)).toBe(true)
    clone.restore('garbage')
    expect(clone.prune(500, 5000)).toBe(1)
    expect(clone.isActive(sid)).toBe(false)
  })
})
