import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createExtensionHookRegistration, PayTrayExtensionClient, PayTrayApiError, SDK_SAFETY } from '../../sdk/src/index.js'
import { getExtensionContractCapabilities } from '../lib/extensionContracts.js'
import { getExtensionOpenApiDocument } from '../lib/extensionOpenApi.js'

const capabilities = getExtensionContractCapabilities()
const openApi = getExtensionOpenApiDocument()
const typeSource = await readFile(new URL('../../sdk/src/index.d.ts', import.meta.url), 'utf8')
const requests = []
const fetchImpl = async (url, options = {}) => {
  requests.push({ url, options })
  return new Response(JSON.stringify({ success: true, apiVersion: 'v2', count: 0, hooks: [], persistence: 'process_local_development_fallback' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

const registration = createExtensionHookRegistration({
  event: capabilities.supportedEvents[0],
  callbackUrl: 'https://extensions.example.com/paytray',
  projections: capabilities.defaultProjections,
  replayWindowSeconds: 300
})
const client = new PayTrayExtensionClient({
  baseUrl: 'https://api.example.com/',
  accessToken: 'ci-access-token',
  fetchImpl
})
await client.getContractCapabilities()
await client.listHooks()
await client.registerHook(registration)

const failures = []
function check(condition, message) {
  if (!condition) failures.push(message)
}

check(SDK_SAFETY.apiVersion === capabilities.apiVersion, 'SDK apiVersion must match runtime capability version')
check(SDK_SAFETY.settlementAuthority === false && capabilities.settlementAuthority === false, 'SDK and runtime must deny settlement authority')
check(SDK_SAFETY.mutation === capabilities.mutation, 'SDK mutation safety must match runtime capability')
check(SDK_SAFETY.aiPromotion === 'shadow_only', 'SDK AI promotion must remain shadow_only')
check(registration.apiVersion === 'v2', 'registration helper must pin apiVersion to v2')
check(registration.event === capabilities.supportedEvents[0], 'registration event must be preserved')
check(registration.callbackUrl === 'https://extensions.example.com/paytray', 'registration callback URL must be preserved')
check(requests.length === 3, 'SDK must issue exactly three documented requests')
check(requests[0]?.url === 'https://api.example.com/api/v2/extensions/contracts', 'capability path drift detected')
check(requests[1]?.url === 'https://api.example.com/api/v2/extensions/hooks', 'hook list path drift detected')
check(requests[2]?.options?.method === 'POST', 'hook registration must use POST')
check(openApi.paths?.['/api/v2/extensions/contracts']?.get?.operationId === 'getExtensionContractCapabilities', 'OpenAPI capability operation drift detected')
check(openApi.paths?.['/api/v2/extensions/hooks']?.get?.operationId === 'listExtensionHooks', 'OpenAPI list operation drift detected')
check(openApi.paths?.['/api/v2/extensions/hooks']?.post?.operationId === 'registerExtensionHook', 'OpenAPI registration operation drift detected')
check(typeSource.includes('export class PayTrayExtensionClient'), 'TypeScript SDK client declaration missing')
check(typeSource.includes("readonly settlementAuthority: false"), 'TypeScript SDK settlement safety declaration missing')
check(typeSource.includes("readonly mutation: 'read_only'"), 'TypeScript SDK mutation safety declaration missing')
check(PayTrayApiError.prototype instanceof Error, 'SDK API error must extend Error')

const result = {
  status: failures.length === 0 ? 'ready' : 'blocked',
  apiVersion: capabilities.apiVersion,
  contractVersion: capabilities.contractVersion,
  requestsCaptured: requests.length,
  sdkSafety: SDK_SAFETY,
  typeDeclarationsChecked: true,
  openApiPathsChecked: Object.keys(openApi.paths),
  failures,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false
}
console.log(JSON.stringify(result, null, 2))
if (failures.length > 0) process.exitCode = 1
