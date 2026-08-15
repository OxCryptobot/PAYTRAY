export type ExtensionProjection = 'identifiers' | 'lifecycle' | 'provenance' | 'timestamps' | 'metrics'

export type ExtensionEvent =
  | 'engagement.created'
  | 'engagement.collaboration_degraded'
  | 'engagement.completed'
  | 'payment.intent_created'
  | 'payment.chain_event_projected'
  | 'payment.reconciliation_attention'
  | 'discovery.outcome_verified'
  | 'risk.review_required'
  | 'ai.shadow_review_recorded'
  | 'ai.shadow_review_replayed'

export interface ExtensionHookRegistration {
  apiVersion: 'v2'
  event: ExtensionEvent | string
  callbackUrl: string
  projections?: ExtensionProjection[]
  replayWindowSeconds?: number
}

export interface ExtensionDelivery {
  signed: true
  retryable: true
  deadLetterObservable: true
}

export interface ExtensionHook extends ExtensionHookRegistration {
  id: string
  ownerWallet: string
  contractVersion: string
  projections: ExtensionProjection[]
  replayWindowSeconds: number
  delivery: ExtensionDelivery
  createdAt: string
}

export interface ExtensionContractCapabilities {
  apiVersion: 'v2'
  contractVersion: string
  supportedEvents: string[]
  allowedProjections: ExtensionProjection[]
  defaultProjections: ExtensionProjection[]
  forbiddenPayloadKeys: string[]
  delivery: ExtensionDelivery & { replayWindowBounded: true }
  settlementAuthority: false
  mutation: 'read_only'
}

export interface PayTrayResponse<T> {
  success: true
  [key: string]: unknown
  data?: T
}

export interface HookListResponse {
  success: true
  apiVersion: 'v2'
  count: number
  hooks: ExtensionHook[]
  persistence: 'postgresql_durable' | 'process_local_development_fallback'
}

export interface HookResponse {
  success: true
  hook: ExtensionHook
  persistence?: 'postgresql_durable' | 'process_local_development_fallback'
}

export interface ContractResponse {
  success: true
  contracts: ExtensionContractCapabilities
}

export interface PayTrayExtensionClientOptions {
  baseUrl: string
  accessToken: string
  fetchImpl?: typeof fetch
}

export class PayTrayApiError extends Error {
  status?: number
  body?: unknown
  url?: string
  constructor(message: string, options?: { status?: number; body?: unknown; url?: string })
}

export function createExtensionHookRegistration(input: {
  event: string
  callbackUrl: string
  projections?: ExtensionProjection[]
  replayWindowSeconds?: number
}): ExtensionHookRegistration

export class PayTrayExtensionClient {
  constructor(options: PayTrayExtensionClientOptions)
  readonly baseUrl: string
  readonly accessToken: string
  getContractCapabilities(): Promise<ContractResponse>
  listHooks(): Promise<HookListResponse>
  registerHook(registration: ExtensionHookRegistration): Promise<HookResponse>
}

export const SDK_SAFETY: {
  readonly apiVersion: 'v2'
  readonly settlementAuthority: false
  readonly mutation: 'read_only'
  readonly aiPromotion: 'shadow_only'
  readonly rawContentPersistence: false
  readonly deliverySemantics: 'at_least_once_bounded_retry'
}
