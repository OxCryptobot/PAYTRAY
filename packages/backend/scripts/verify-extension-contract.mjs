import { getExtensionContractCapabilities } from '../lib/extensionContracts.js'
import { getExtensionOpenApiDocument } from '../lib/extensionOpenApi.js'

const capabilities = getExtensionContractCapabilities()
const document = getExtensionOpenApiDocument()
const failures = []

function assert(condition, message) {
  if (!condition) failures.push(message)
}

assert(document.openapi === '3.1.0', 'OpenAPI document must use 3.1.0')
assert(document.info.version === capabilities.contractVersion, 'OpenAPI version must match the contract version')
assert(document.paths?.['/api/v2/extensions/contracts']?.get, 'contract capabilities GET path is missing')
assert(document.paths?.['/api/v2/extensions/hooks']?.get, 'hook listing GET path is missing')
assert(document.paths?.['/api/v2/extensions/hooks']?.post, 'hook registration POST path is missing')
assert(document.components?.securitySchemes?.bearerAuth?.scheme === 'bearer', 'bearer authentication scheme is missing')
assert(document.components?.schemas?.ExtensionHookRegistration?.properties?.apiVersion?.const === 'v2', 'hook registration must be pinned to v2')
assert(document.components?.schemas?.ExtensionContractCapabilities?.properties?.settlementAuthority?.const === false, 'contract must deny settlement authority')
assert(document.components?.schemas?.ExtensionContractCapabilities?.properties?.mutation?.const === 'read_only', 'contract must be read-only')
assert(document['x-paytray-safety']?.settlementAuthority === false, 'document safety metadata must deny settlement authority')
assert(document['x-paytray-safety']?.aiPromotion === 'shadow_only', 'document safety metadata must retain shadow-only AI')
assert(JSON.stringify(document.components.schemas.ExtensionHookRegistration.properties.event.enum) === JSON.stringify(capabilities.supportedEvents), 'event enum must match runtime capabilities')
assert(JSON.stringify(document.components.schemas.ExtensionHookRegistration.properties.projections.items.enum) === JSON.stringify(capabilities.allowedProjections), 'projection enum must match runtime capabilities')
assert(document.components.schemas.ExtensionHookRegistration.properties.callbackUrl.pattern === '^https://', 'callback URL schema must require HTTPS')
assert(document.components.schemas.ExtensionHookRegistration.properties.replayWindowSeconds.minimum === 60, 'replay window lower bound is missing')
assert(document.components.schemas.ExtensionHookRegistration.properties.replayWindowSeconds.maximum === 86400, 'replay window upper bound is missing')

const result = {
  status: failures.length === 0 ? 'ready' : 'blocked',
  contractVersion: capabilities.contractVersion,
  apiVersion: capabilities.apiVersion,
  paths: Object.keys(document.paths),
  supportedEvents: capabilities.supportedEvents.length,
  allowedProjections: capabilities.allowedProjections.length,
  settlementAuthority: capabilities.settlementAuthority,
  mutation: capabilities.mutation,
  aiPromotion: document['x-paytray-safety']?.aiPromotion,
  rawContentPersistence: document['x-paytray-safety']?.rawContentPersistence,
  failures,
  deploymentPerformed: false,
  settlementMutationPerformed: false
}

console.log(JSON.stringify(result, null, 2))
if (failures.length > 0) process.exit(1)
