# `@paytray/sdk`

`@paytray/sdk` is the dependency-free Node 18+ client for PayTray’s versioned v2 extension contract. It helps an authenticated extension owner discover capabilities, list owner-scoped hooks, and register HTTPS callback hooks without exposing payment, ledger, settlement, or AI-promotion mutation methods.

> Extension delivery is downstream evidence only. Verifier-owned chain evidence remains the economic authority, and AI ranking remains `shadow_only`.

## Usage

```js
import { PayTrayExtensionClient, createExtensionHookRegistration } from '@paytray/sdk'

const client = new PayTrayExtensionClient({
  baseUrl: process.env.PAYTRAY_API_URL,
  accessToken: process.env.PAYTRAY_ACCESS_TOKEN
})

const capabilities = await client.getContractCapabilities()
const registration = createExtensionHookRegistration({
  event: 'engagement.created',
  callbackUrl: 'https://extensions.example.com/paytray',
  projections: ['identifiers', 'lifecycle', 'provenance'],
  replayWindowSeconds: 300
})
const result = await client.registerHook(registration)
console.log(capabilities.contracts.contractVersion, result.hook.id)
```

The client sends bearer authentication and JSON requests, enforces HTTPS in the local registration helper, and throws `PayTrayApiError` for non-success responses with the HTTP status, parsed response body, and request URL attached. Consumers should keep access tokens outside source control and should independently verify signed deliveries according to the server’s webhook contract.

The server publishes the matching OpenAPI 3.1 document at `/api/v2/extensions/openapi.json`. The public document is descriptive only; hook registration and listing still require the `extensions:*` scope. Durable production persistence requires PostgreSQL migration `017_extension_hooks`; process-local fallback is limited to non-production development.

## Safety contract

| Property | SDK guarantee |
|---|---|
| API version | v2 only |
| Settlement authority | Always false |
| Mutation | Read-only extension operations |
| AI promotion | Shadow-only; no promotion method exists |
| Raw collaboration content | Not accepted by the public projection contract |
| Delivery | Signed, retryable, dead-letter observable, bounded replay window |
