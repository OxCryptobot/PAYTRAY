import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { verifyMessage } from 'ethers'
import config from './config.js'
import { AuthenticationError, RateLimitError } from './errors.js'

export function generateToken(payload, expiresIn = config.jwt.accessTokenTTL) {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn,
    algorithm: 'HS256',
    issuer: 'paytray'
  })
}

export function generateServiceToken(payload, secret, expiresIn, issuer = 'paytray-service') {
  if (!secret || typeof secret !== 'string') {
    throw new AuthenticationError('Service token secret is missing')
  }

  return jwt.sign(payload, secret, {
    expiresIn,
    algorithm: 'HS256',
    issuer
  })
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] })
  } catch (error) {
    throw new AuthenticationError(error.message)
  }
}

export function decodeToken(token) {
  return jwt.decode(token)
}

export function generateTokenPair(userId, walletAddress, scopes = ['core:access']) {
  return {
    accessToken: generateToken({ userId, walletAddress, scopes, type: 'access' }, config.jwt.accessTokenTTL),
    refreshToken: generateToken({ userId, walletAddress, scopes, type: 'refresh' }, config.jwt.refreshTokenTTL)
  }
}

export function verifyWalletSignature(message, signature, address) {
  try {
    if (typeof message !== 'string' || typeof signature !== 'string' || typeof address !== 'string') {
      throw new AuthenticationError('Invalid signature payload')
    }

    const recoveredAddress = verifyMessage(message, signature)
    const verified = recoveredAddress.toLowerCase() === address.toLowerCase()

    return {
      verified,
      address: recoveredAddress.toLowerCase(),
      message
    }
  } catch (error) {
    throw new AuthenticationError(`Signature verification failed: ${error.message}`)
  }
}

export function hashValue(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function hashWithSalt(value, salt = crypto.randomBytes(16)) {
  const derivedKey = crypto.pbkdf2Sync(String(value), salt, 100000, 64, 'sha512').toString('hex')
  return `${derivedKey}:${salt.toString('hex')}`
}

export function verifyHash(value, hashedValue) {
  try {
    const [derivedKey, saltHex] = hashedValue.split(':')
    const salt = Buffer.from(saltHex, 'hex')
    const comparison = crypto.pbkdf2Sync(String(value), salt, 100000, 64, 'sha512').toString('hex')
    return crypto.timingSafeEqual(Buffer.from(comparison, 'hex'), Buffer.from(derivedKey, 'hex'))
  } catch {
    return false
  }
}

export function generateRandomToken(length = 32) {
  return crypto.randomBytes(length).toString('hex')
}

export const rateLimitMap = new Map()

export function checkRateLimit(key, limit = config.rateLimit.max, windowMs = config.rateLimit.windowMs) {
  const now = Date.now()
  const record = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs }

  if (now > record.resetAt) {
    record.count = 0
    record.resetAt = now + windowMs
  }

  record.count += 1
  rateLimitMap.set(key, record)

  if (record.count > limit) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000)
    throw new RateLimitError(`Rate limit exceeded. Retry after ${retryAfter}s`, retryAfter)
  }

  return {
    remaining: Math.max(0, limit - record.count),
    resetAt: record.resetAt
  }
}

export function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for']
  return (
    (typeof forwarded === 'string' && forwarded.split(',')[0].trim()) ||
    req.headers['x-client-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  )
}

export default {
  generateToken,
  generateServiceToken,
  verifyToken,
  decodeToken,
  generateTokenPair,
  verifyWalletSignature,
  hashValue,
  hashWithSalt,
  verifyHash,
  generateRandomToken,
  checkRateLimit,
  getClientIP,
  rateLimitMap
}
