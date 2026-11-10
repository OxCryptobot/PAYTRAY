// Refresh-token families with rotation and reuse detection.
// Each login creates a family (sid). Every refresh rotates the refresh token's jti; presenting an
// already-rotated jti is treated as token theft and revokes the whole family. Access tokens carry the
// sid, so revocation takes effect immediately.
import crypto from 'crypto'

export class SessionStore {
  constructor() {
    this.families = new Map()
  }

  create(userId, wallet, scopes, now = Date.now()) {
    const sid = crypto.randomUUID()
    const jti = crypto.randomUUID()
    this.families.set(sid, {
      sid,
      userId,
      wallet,
      scopes,
      currentJti: jti,
      revoked: false,
      revokedReason: null,
      createdAt: now,
      rotatedAt: now,
      rotations: 0
    })
    return { sid, jti }
  }

  isActive(sid) {
    const family = this.families.get(sid)
    return Boolean(family) && !family.revoked
  }

  get(sid) {
    return this.families.get(sid) || null
  }

  rotate(sid, presentedJti, now = Date.now()) {
    const family = this.families.get(sid)
    if (!family) return { ok: false, reason: 'unknown_session' }
    if (family.revoked) return { ok: false, reason: 'revoked' }
    if (presentedJti !== family.currentJti) {
      family.revoked = true
      family.revokedReason = 'refresh_reuse_detected'
      return { ok: false, reason: 'reuse_detected' }
    }
    family.currentJti = crypto.randomUUID()
    family.rotatedAt = now
    family.rotations += 1
    return { ok: true, family, jti: family.currentJti }
  }

  revoke(sid, reason = 'logout') {
    const family = this.families.get(sid)
    if (!family) return false
    family.revoked = true
    family.revokedReason = reason
    return true
  }

  revokeAllForWallet(wallet, reason = 'revoke_all') {
    let count = 0
    for (const family of this.families.values()) {
      if (family.wallet === wallet && !family.revoked) {
        family.revoked = true
        family.revokedReason = reason
        count += 1
      }
    }
    return count
  }

  listForWallet(wallet) {
    return Array.from(this.families.values())
      .filter((family) => family.wallet === wallet)
      .map(({ sid, revoked, revokedReason, createdAt, rotatedAt, rotations }) => ({ sid, revoked, revokedReason, createdAt, rotatedAt, rotations }))
  }

  // Drop revoked families after a grace period and idle ones to bound memory.
  prune(maxIdleMs, now = Date.now()) {
    let removed = 0
    for (const [sid, family] of this.families) {
      if (now - family.rotatedAt > maxIdleMs) {
        this.families.delete(sid)
        removed += 1
      }
    }
    return removed
  }

  toJSON() {
    return Array.from(this.families.values())
  }

  restore(list) {
    if (!Array.isArray(list)) return
    for (const family of list) {
      if (family && typeof family.sid === 'string' && typeof family.currentJti === 'string') {
        this.families.set(family.sid, family)
      }
    }
  }
}

export default SessionStore
