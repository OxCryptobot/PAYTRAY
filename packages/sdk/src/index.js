const DEFAULT_HEADERS = Object.freeze({ accept: 'application/json' })

export class PayTrayApiError extends Error {
  constructor(message, { status, body, url } = {}) {
    super(message)
    this.name = 'PayTrayApiError'
    this.status = status
    this.body = body
    this.url = url
  }
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/$/, '')
  if (!value) throw new TypeError('baseUrl is required')
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('baseUrl must use http or https')
  return value
}

function assertAccessToken(accessToken) {
  const value = String(accessToken || '').trim()
  if (!value) throw new TypeError('accessToken is required')
  return value
}

function normalizeRequestBody(body) {
  if (body == null) return undefined
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('request body must be an object')
  return JSON.stringify(body)
}

export function createExtensionHookRegistration({ event, callbackUrl, projections, replayWindowSeconds = 300 } = {}) {
  const normalizedEvent = String(event || '').trim()
  const normalizedCallbackUrl = String(callbackUrl || '').trim()
  if (!normalizedEvent) throw new TypeError('event is required')
  if (!normalizedCallbackUrl.startsWith('https://')) throw new TypeError('callbackUrl must use https')
  const registration = {
    apiVersion: 'v2',
    event: normalizedEvent,
    callbackUrl: normalizedCallbackUrl,
    replayWindowSeconds
  }
  if (projections !== undefined) {
    if (!Array.isArray(projections) || projections.length === 0 || projections.some((projection) => typeof projection !== 'string' || !projection.trim())) throw new TypeError('projections must be a non-empty string array')
    registration.projections = [...new Set(projections)]
  }
  if (!Number.isInteger(replayWindowSeconds) || replayWindowSeconds < 60 || replayWindowSeconds > 86400) throw new TypeError('replayWindowSeconds must be an integer between 60 and 86400')
  return registration
}

export class PayTrayExtensionClient {
  constructor({ baseUrl, accessToken, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.accessToken = assertAccessToken(accessToken)
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
    this.fetchImpl = fetchImpl
  }

  async request(path, { method = 'GET', body } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/v2/extensions/')) throw new TypeError('path must stay within the v2 extension API')
    const urlObject = new URL(path, `${this.baseUrl}/`)
    const baseOrigin = new URL(this.baseUrl).origin
    if (urlObject.origin !== baseOrigin) throw new TypeError('path must stay on the configured API origin')
    const url = urlObject.toString()
    const headers = {
      ...DEFAULT_HEADERS,
      authorization: `Bearer ${this.accessToken}`
    }
    const serializedBody = normalizeRequestBody(body)
    if (serializedBody !== undefined) {
      headers['content-type'] = 'application/json'
    }

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: serializedBody
    })
    let payload = null
    const contentType = response.headers?.get?.('content-type') || ''
    if (contentType.includes('application/json')) {
      payload = await response.json()
    } else {
      const text = await response.text()
      payload = text ? { raw: text } : null
    }
    if (!response.ok) {
      const detail = payload?.error || payload?.message || `PayTray request failed with HTTP ${response.status}`
      throw new PayTrayApiError(detail, { status: response.status, body: payload, url })
    }
    return payload
  }

  getContractCapabilities() {
    return this.request('/api/v2/extensions/contracts')
  }

  listHooks() {
    return this.request('/api/v2/extensions/hooks')
  }

  registerHook(registration) {
    return this.request('/api/v2/extensions/hooks', {
      method: 'POST',
      body: registration
    })
  }
}

export const SDK_SAFETY = Object.freeze({
  apiVersion: 'v2',
  settlementAuthority: false,
  mutation: 'read_only',
  aiPromotion: 'shadow_only',
  rawContentPersistence: false,
  deliverySemantics: 'at_least_once_bounded_retry'
})
