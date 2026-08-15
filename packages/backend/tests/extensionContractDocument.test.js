import { describe, expect, it } from 'vitest'
import request from 'supertest'
import app from '../server.js'
import { getExtensionContractCapabilities } from '../lib/extensionContracts.js'
import { getExtensionOpenApiDocument } from '../lib/extensionOpenApi.js'
import { PayTrayApiError, PayTrayExtensionClient, SDK_SAFETY, createExtensionHookRegistration } from '../../sdk/src/index.js'

describe('public extension contract and SDK', () => {
  it('serves a public OpenAPI document with the runtime contract and safety boundary', async () => {
    const response = await request(app).get('/api/v2/extensions/openapi.json')

    expect(response.status).toBe(200)
    expect(response.body.openapi).toBe('3.1.0')
    expect(response.body.info.version).toBe(getExtensionContractCapabilities().contractVersion)
    expect(response.body.paths['/api/v2/extensions/hooks'].post).toBeDefined()
    expect(response.body.components.schemas.ExtensionHookRegistration.properties.callbackUrl.pattern).toBe('^https://')
    expect(response.body['x-paytray-safety']).toMatchObject({ settlementAuthority: false, mutation: 'read_only', aiPromotion: 'shadow_only', rawContentPersistence: false })
  })

  it('keeps the generated contract aligned with runtime capabilities', () => {
    const document = getExtensionOpenApiDocument()
    const capabilities = getExtensionContractCapabilities()

    expect(document.components.schemas.ExtensionHookRegistration.properties.event.enum).toEqual(capabilities.supportedEvents)
    expect(document.components.schemas.ExtensionHookRegistration.properties.projections.items.enum).toEqual(capabilities.allowedProjections)
    expect(document.components.schemas.ExtensionContractCapabilities.properties.mutation.const).toBe('read_only')
    expect(SDK_SAFETY).toMatchObject({ apiVersion: 'v2', settlementAuthority: false, mutation: 'read_only', aiPromotion: 'shadow_only' })
  })

  it('creates an HTTPS-only registration without adding raw content or credentials', () => {
    const registration = createExtensionHookRegistration({
      event: 'engagement.created',
      callbackUrl: 'https://example.com/paytray',
      projections: ['identifiers', 'lifecycle'],
      replayWindowSeconds: 600
    })

    expect(registration).toEqual({
      apiVersion: 'v2',
      event: 'engagement.created',
      callbackUrl: 'https://example.com/paytray',
      projections: ['identifiers', 'lifecycle'],
      replayWindowSeconds: 600
    })
    expect(() => createExtensionHookRegistration({ event: 'engagement.created', callbackUrl: 'http://example.com' })).toThrow('https')
    expect(() => createExtensionHookRegistration({ event: 'engagement.created', callbackUrl: 'https://example.com', projections: 'identifiers' })).toThrow('string array')
    expect(() => createExtensionHookRegistration({ event: 'engagement.created', callbackUrl: 'https://example.com', replayWindowSeconds: 30 })).toThrow('replayWindowSeconds')
  })

  it('uses bearer authentication and exposes structured API errors', async () => {
    const calls = []
    const fetchImpl = async (url, options) => {
      calls.push({ url, options })
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async json() { return { success: true, contracts: getExtensionContractCapabilities() } }
      }
    }
    const client = new PayTrayExtensionClient({ baseUrl: 'https://api.example.test', accessToken: 'jwt-token', fetchImpl })
    const response = await client.getContractCapabilities()

    expect(response.success).toBe(true)
    expect(calls[0].url).toBe('https://api.example.test/api/v2/extensions/contracts')
    expect(calls[0].options.headers.authorization).toBe('Bearer jwt-token')
    expect(calls[0].options.headers.accept).toBe('application/json')
    await expect(client.request('/api/users/me')).rejects.toThrow('v2 extension API')

    const failingClient = new PayTrayExtensionClient({
      baseUrl: 'https://api.example.test',
      accessToken: 'jwt-token',
      fetchImpl: async () => ({
        ok: false,
        status: 403,
        headers: { get: () => 'application/json' },
        async json() { return { error: 'Missing required scopes' } }
      })
    })

    await expect(failingClient.listHooks()).rejects.toMatchObject({ name: 'PayTrayApiError', status: 403, body: { error: 'Missing required scopes' } })
    await expect(failingClient.listHooks()).rejects.toBeInstanceOf(PayTrayApiError)
  })
})
