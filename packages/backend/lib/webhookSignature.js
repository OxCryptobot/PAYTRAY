import crypto from 'node:crypto'

export class WebhookSignatureError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WebhookSignatureError'
  }
}

function normalizeSecret(secret) {
  if (typeof secret !== 'string' || secret.length === 0) throw new WebhookSignatureError('Webhook signing secret is required')
  return secret
}

function parseTimestamp(timestamp) {
  const normalized = String(timestamp || '')
  if (!/^\d+$/.test(normalized)) throw new WebhookSignatureError('Webhook timestamp must be an integer in milliseconds')
  const timestampMs = Number(normalized)
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) throw new WebhookSignatureError('Webhook timestamp is invalid')
  return timestampMs
}

function parseSignatureHeader(signatureHeader) {
  if (typeof signatureHeader !== 'string') throw new WebhookSignatureError('Webhook signature header is required')
  const match = /^v1=([a-f0-9]{64})$/i.exec(signatureHeader.trim())
  if (!match) throw new WebhookSignatureError('Webhook signature header is invalid')
  return Buffer.from(match[1], 'hex')
}

function assertTimestampFresh(timestampMs, { nowMs = Date.now(), toleranceMs = 300000 } = {}) {
  if (!Number.isSafeInteger(nowMs)) throw new WebhookSignatureError('Current timestamp is invalid')
  if (!Number.isInteger(toleranceMs) || toleranceMs < 1000 || toleranceMs > 86400000) throw new WebhookSignatureError('Webhook timestamp tolerance is invalid')
  const skewMs = Math.abs(nowMs - timestampMs)
  if (skewMs > toleranceMs) throw new WebhookSignatureError('Webhook timestamp is outside the allowed skew window')
  return skewMs
}

export function createWebhookSignature({ timestamp, body, secret }) {
  const normalizedSecret = normalizeSecret(secret)
  const timestampMs = parseTimestamp(timestamp)
  if (typeof body !== 'string') throw new WebhookSignatureError('Webhook body must be a string')
  return crypto.createHmac('sha256', normalizedSecret).update(`${timestampMs}.${body}`, 'utf8').digest('hex')
}

export function createWebhookSignatureHeader({ timestamp, body, secret }) {
  return `v1=${createWebhookSignature({ timestamp, body, secret })}`
}

export class WebhookReplayGuard {
  constructor({ maxEntries = 10000, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 1000000) throw new WebhookSignatureError('Replay guard maxEntries is invalid')
    this.maxEntries = maxEntries
    this.now = now
    this.entries = new Map()
  }

  prune(nowMs = this.now()) {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= nowMs) this.entries.delete(key)
    }
  }

  consume(key, expiresAt) {
    const normalizedKey = String(key || '')
    if (!normalizedKey) throw new WebhookSignatureError('Webhook replay key is required')
    const nowMs = this.now()
    this.prune(nowMs)
    if (this.entries.has(normalizedKey)) throw new WebhookSignatureError('Webhook replay detected')
    const normalizedExpiry = Number(expiresAt)
    if (!Number.isSafeInteger(normalizedExpiry) || normalizedExpiry <= nowMs) throw new WebhookSignatureError('Webhook replay expiry is invalid')
    this.entries.set(normalizedKey, normalizedExpiry)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      this.entries.delete(oldest)
    }
    return true
  }
}

export async function verifyWebhookSignatureWithReplayClaim({
  timestamp,
  body,
  signatureHeader,
  secret,
  toleranceMs = 300000,
  nowMs = Date.now(),
  replayKey,
  claimReplay
}) {
  if (typeof claimReplay !== 'function') throw new WebhookSignatureError('Durable replay claim function is required')
  const verified = verifyWebhookSignature({ timestamp, body, signatureHeader, secret, toleranceMs, nowMs })
  const claimed = await claimReplay({ replayKey, expiresAt: verified.timestampMs + toleranceMs, nowMs })
  if (!claimed || claimed.claimed !== true) throw new WebhookSignatureError('Webhook replay detected')
  return { ...verified, replayProtected: true, replayStore: claimed.store || 'durable', replayClaimAtomic: claimed.atomic !== false }
}

export function verifyWebhookSignature({ timestamp, body, signatureHeader, secret, toleranceMs = 300000, nowMs = Date.now(), replayGuard = null, replayKey = null }) {
  const timestampMs = parseTimestamp(timestamp)
  const skewMs = assertTimestampFresh(timestampMs, { nowMs, toleranceMs })
  const expected = Buffer.from(createWebhookSignature({ timestamp: timestampMs, body, secret }), 'hex')
  const provided = parseSignatureHeader(signatureHeader)
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) throw new WebhookSignatureError('Webhook signature verification failed')
  if (replayGuard) {
    if (!(replayGuard instanceof WebhookReplayGuard)) throw new WebhookSignatureError('Replay guard is invalid')
    if (!replayKey) throw new WebhookSignatureError('Replay key is required when replay protection is enabled')
    replayGuard.consume(replayKey, timestampMs + toleranceMs)
  }
  return { verified: true, timestampMs, skewMs, replayProtected: Boolean(replayGuard) }
}

export { assertTimestampFresh, parseSignatureHeader, parseTimestamp }
