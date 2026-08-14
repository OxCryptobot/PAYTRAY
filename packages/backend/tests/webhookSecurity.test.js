import { describe, expect, it } from 'vitest'
import { assertSafeWebhookUrl, validateWebhookUrl } from '../lib/webhookSecurity.js'

describe('webhook security', () => {
  it('accepts a public HTTPS URL with public DNS resolution', async () => {
    await expect(assertSafeWebhookUrl('https://hooks.example.com/events', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    })).resolves.toBe('https://hooks.example.com/events')
  })

  it('rejects loopback, private, link-local, metadata, and credential-bearing URLs', async () => {
    expect(() => validateWebhookUrl('http://127.0.0.1/hook')).toThrow('blocked network address')
    expect(() => validateWebhookUrl('http://169.254.169.254/latest/meta-data')).toThrow('blocked network address')
    expect(() => validateWebhookUrl('https://user:pass@example.com/hook')).toThrow('credentials')
    await expect(assertSafeWebhookUrl('https://hooks.example.com/events', {
      lookup: async () => [{ address: '10.0.0.8', family: 4 }]
    })).rejects.toThrow('blocked network address')
  })

  it('rejects unsupported protocols and non-standard ports', () => {
    expect(() => validateWebhookUrl('file:///etc/passwd')).toThrow('http or https')
    expect(() => validateWebhookUrl('https://hooks.example.com:8443/events')).toThrow('ports 80 or 443')
  })
})
