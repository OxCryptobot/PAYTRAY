import { getExtensionContractCapabilities } from './extensionContracts.js'

const ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
    requestId: { type: 'string' }
  },
  additionalProperties: true
}

const HOOK_SCHEMA = {
  type: 'object',
  required: ['apiVersion', 'event', 'callbackUrl'],
  properties: {
    apiVersion: { type: 'string', const: 'v2' },
    event: { type: 'string' },
    callbackUrl: { type: 'string', format: 'uri', pattern: '^https://' },
    projections: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { type: 'string' }
    },
    replayWindowSeconds: { type: 'integer', minimum: 60, maximum: 86400, default: 300 }
  },
  additionalProperties: false
}

const HOOK_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['id', 'ownerWallet', 'apiVersion', 'contractVersion', 'event', 'callbackUrl', 'projections', 'replayWindowSeconds', 'delivery', 'createdAt'],
  properties: {
    id: { type: 'string' },
    ownerWallet: { type: 'string' },
    apiVersion: { type: 'string', const: 'v2' },
    contractVersion: { type: 'string' },
    event: { type: 'string' },
    callbackUrl: { type: 'string', format: 'uri' },
    projections: { type: 'array', items: { type: 'string' } },
    replayWindowSeconds: { type: 'integer' },
    delivery: {
      type: 'object',
      required: ['signed', 'retryable', 'deadLetterObservable'],
      properties: {
        signed: { type: 'boolean', const: true },
        retryable: { type: 'boolean', const: true },
        deadLetterObservable: { type: 'boolean', const: true }
      },
      additionalProperties: false
    },
    createdAt: { type: 'string', format: 'date-time' }
  },
  additionalProperties: false
}

function response(description, schema, status = '200') {
  return {
    [status]: {
      description,
      content: { 'application/json': { schema } }
    }
  }
}

export function getExtensionOpenApiDocument({ serverUrl = null } = {}) {
  const capabilities = getExtensionContractCapabilities()
  const document = {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'PayTray v2 Public Extension API',
      version: capabilities.contractVersion,
      description: 'Versioned, signed, retryable extension delivery contracts for verifier-owned PayTray evidence. Extension delivery is downstream evidence only and cannot establish settlement, mutate the ledger, or promote AI.',
      license: { name: 'MIT' }
    },
    ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
    tags: [{ name: 'Extensions', description: 'Bounded v2 extension capabilities and durable hook registration.' }],
    paths: {
      '/api/v2/extensions/contracts': {
        get: {
          tags: ['Extensions'],
          summary: 'Read extension contract capabilities',
          operationId: 'getExtensionContractCapabilities',
          security: [{ bearerAuth: [] }],
          responses: response('Contract capabilities', {
            type: 'object',
            required: ['success', 'contracts'],
            properties: {
              success: { type: 'boolean', const: true },
              contracts: { $ref: '#/components/schemas/ExtensionContractCapabilities' }
            },
            additionalProperties: false
          })
        }
      },
      '/api/v2/extensions/hooks': {
        get: {
          tags: ['Extensions'],
          summary: 'List owner-scoped durable v2 hooks',
          operationId: 'listExtensionHooks',
          security: [{ bearerAuth: [] }],
          responses: response('Owner-scoped hooks', {
            type: 'object',
            required: ['success', 'apiVersion', 'count', 'hooks', 'persistence'],
            properties: {
              success: { type: 'boolean', const: true },
              apiVersion: { type: 'string', const: 'v2' },
              count: { type: 'integer', minimum: 0 },
              hooks: { type: 'array', items: { $ref: '#/components/schemas/ExtensionHook' } },
              persistence: { type: 'string', enum: ['postgresql_durable', 'process_local_development_fallback'] }
            },
            additionalProperties: false
          })
        },
        post: {
          tags: ['Extensions'],
          summary: 'Register an owner-scoped durable v2 hook',
          operationId: 'registerExtensionHook',
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ExtensionHookRegistration' } } }
          },
          responses: response('Registered hook', {
            type: 'object',
            required: ['success', 'hook'],
            properties: {
              success: { type: 'boolean', const: true },
              hook: { $ref: '#/components/schemas/ExtensionHook' },
              persistence: { type: 'string' }
            },
            additionalProperties: false
          })
        }
      }
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
      },
      schemas: {
        ExtensionHookRegistration: {
          ...HOOK_SCHEMA,
          properties: {
            ...HOOK_SCHEMA.properties,
            event: { type: 'string', enum: capabilities.supportedEvents },
            projections: { ...HOOK_SCHEMA.properties.projections, items: { type: 'string', enum: capabilities.allowedProjections } }
          }
        },
        ExtensionHook: HOOK_RESPONSE_SCHEMA,
        ExtensionContractCapabilities: {
          type: 'object',
          required: ['apiVersion', 'contractVersion', 'supportedEvents', 'allowedProjections', 'defaultProjections', 'forbiddenPayloadKeys', 'delivery', 'settlementAuthority', 'mutation'],
          properties: {
            apiVersion: { type: 'string', const: 'v2' },
            contractVersion: { type: 'string' },
            supportedEvents: { type: 'array', items: { type: 'string', enum: capabilities.supportedEvents } },
            allowedProjections: { type: 'array', items: { type: 'string', enum: capabilities.allowedProjections } },
            defaultProjections: { type: 'array', items: { type: 'string', enum: capabilities.allowedProjections } },
            forbiddenPayloadKeys: { type: 'array', items: { type: 'string' } },
            delivery: {
              type: 'object',
              required: ['signed', 'retryable', 'deadLetterObservable', 'replayWindowBounded'],
              properties: {
                signed: { type: 'boolean', const: true },
                retryable: { type: 'boolean', const: true },
                deadLetterObservable: { type: 'boolean', const: true },
                replayWindowBounded: { type: 'boolean', const: true }
              },
              additionalProperties: false
            },
            settlementAuthority: { type: 'boolean', const: false },
            mutation: { type: 'string', const: 'read_only' }
          },
          additionalProperties: false
        },
        Error: ERROR_SCHEMA
      },
      responses: {
        BadRequest: {
          description: 'Validation failed',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
        },
        Unauthorized: {
          description: 'Authentication failed',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
        },
        Forbidden: {
          description: 'Required extension scope is missing',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } }
        }
      }
    },
    'x-paytray-safety': {
      authority: 'verifier_owned_chain_evidence',
      settlementAuthority: false,
      mutation: 'read_only',
      rawContentPersistence: false,
      aiPromotion: 'shadow_only',
      deliverySemantics: 'at_least_once_bounded_retry',
      contractVersion: capabilities.contractVersion
    }
  }
  return document
}

export { HOOK_RESPONSE_SCHEMA }
export default getExtensionOpenApiDocument
