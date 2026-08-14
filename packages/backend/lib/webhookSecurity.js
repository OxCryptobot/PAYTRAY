import dns from 'node:dns/promises'
import net from 'node:net'

export class WebhookSecurityError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WebhookSecurityError'
  }
}

function isBlockedHostname(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal'
}

function isBlockedIp(address) {
  const normalized = address.toLowerCase()
  const ipVersion = net.isIP(normalized)
  if (ipVersion === 4) {
    const octets = normalized.split('.').map(Number)
    const [first, second] = octets
    return first === 0 || first === 10 || first === 127 || (first === 169 && second === 254) || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 100 && second >= 64 && second <= 127) || first >= 224
  }
  if (ipVersion === 6) {
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.')
  }
  return true
}

export function validateWebhookUrl(value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new WebhookSecurityError('callbackUrl is required')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new WebhookSecurityError('callbackUrl must be a valid URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new WebhookSecurityError('callbackUrl must use http or https')
  if (parsed.username || parsed.password) throw new WebhookSecurityError('callbackUrl cannot contain credentials')
  if (parsed.port && !['80', '443'].includes(parsed.port)) throw new WebhookSecurityError('callbackUrl must use ports 80 or 443')
  if (isBlockedHostname(parsed.hostname) || (net.isIP(parsed.hostname) && isBlockedIp(parsed.hostname))) throw new WebhookSecurityError('callbackUrl resolves to a blocked network address')
  return parsed.toString()
}

export async function assertSafeWebhookUrl(value, { lookup = dns.lookup } = {}) {
  const normalized = validateWebhookUrl(value)
  const hostname = new URL(normalized).hostname
  if (net.isIP(hostname)) return normalized
  let addresses
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new WebhookSecurityError('callbackUrl hostname could not be resolved')
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedIp(address))) throw new WebhookSecurityError('callbackUrl resolves to a blocked network address')
  return normalized
}

export { isBlockedIp }
