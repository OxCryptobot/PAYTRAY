export const PAYMENT_STREAM_STATES = Object.freeze([
  'draft',
  'intent_created',
  'wallet_submitted',
  'chain_pending',
  'chain_included',
  'chain_finalized',
  'ledger_reflected',
  'paused',
  'cancel_requested',
  'cancel_finalized',
  'withdrawal_pending',
  'withdrawal_finalized',
  'disputed',
  'failed'
])

export const PAYMENT_EVENT_SOURCES = Object.freeze([
  'api',
  'wallet',
  'verifier',
  'ledger_worker',
  'operations',
  'mock_adapter'
])

const TRANSITIONS = Object.freeze({
  draft: Object.freeze({ intent_created: ['api'], failed: ['api'] }),
  intent_created: Object.freeze({ wallet_submitted: ['wallet', 'api'], failed: ['api', 'wallet'] }),
  wallet_submitted: Object.freeze({ chain_pending: ['verifier', 'mock_adapter'], failed: ['verifier', 'mock_adapter'] }),
  chain_pending: Object.freeze({ chain_included: ['verifier', 'mock_adapter'], failed: ['verifier', 'mock_adapter'] }),
  chain_included: Object.freeze({ chain_finalized: ['verifier', 'mock_adapter'], failed: ['verifier', 'mock_adapter'] }),
  chain_finalized: Object.freeze({
    ledger_reflected: ['ledger_worker', 'mock_adapter'],
    paused: ['verifier', 'mock_adapter'],
    cancel_finalized: ['verifier', 'mock_adapter'],
    withdrawal_finalized: ['verifier', 'mock_adapter'],
    disputed: ['operations']
  }),
  ledger_reflected: Object.freeze({
    paused: ['verifier', 'mock_adapter'],
    cancel_requested: ['api', 'wallet'],
    withdrawal_pending: ['api', 'wallet'],
    disputed: ['operations']
  }),
  paused: Object.freeze({
    wallet_submitted: ['wallet', 'api'],
    cancel_requested: ['api', 'wallet'],
    disputed: ['operations']
  }),
  cancel_requested: Object.freeze({ wallet_submitted: ['wallet', 'api'], failed: ['verifier', 'mock_adapter'] }),
  cancel_finalized: Object.freeze({ withdrawal_pending: ['api', 'wallet'], withdrawal_finalized: ['verifier', 'mock_adapter'], disputed: ['operations'] }),
  withdrawal_pending: Object.freeze({ wallet_submitted: ['wallet', 'api'], failed: ['verifier', 'mock_adapter'] }),
  withdrawal_finalized: Object.freeze({ ledger_reflected: ['ledger_worker', 'mock_adapter'], cancel_finalized: ['verifier', 'mock_adapter'], disputed: ['operations'] }),
  disputed: Object.freeze({ ledger_reflected: ['operations'], cancel_finalized: ['operations'], failed: ['operations'] }),
  failed: Object.freeze({ intent_created: ['api'], wallet_submitted: ['wallet', 'api'], draft: ['api'] })
})

export class PaymentLifecycleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PaymentLifecycleError'
  }
}

export function isPaymentStreamState(value) {
  return PAYMENT_STREAM_STATES.includes(value)
}

export function getAllowedTransitions(fromState) {
  if (!isPaymentStreamState(fromState)) {
    throw new PaymentLifecycleError(`Unknown payment stream state: ${fromState}`)
  }
  return Object.keys(TRANSITIONS[fromState])
}

export function assertPaymentTransition({ from, to, source }) {
  if (!isPaymentStreamState(from)) {
    throw new PaymentLifecycleError(`Unknown payment stream state: ${from}`)
  }
  if (!isPaymentStreamState(to)) {
    throw new PaymentLifecycleError(`Unknown payment stream state: ${to}`)
  }
  if (!PAYMENT_EVENT_SOURCES.includes(source)) {
    throw new PaymentLifecycleError(`Unknown payment event source: ${source}`)
  }

  const permittedSources = TRANSITIONS[from][to]
  if (!permittedSources) {
    throw new PaymentLifecycleError(`Cannot transition payment stream from ${from} to ${to}`)
  }
  if (!permittedSources.includes(source)) {
    throw new PaymentLifecycleError(`Payment stream transition from ${from} to ${to} is not owned by ${source}`)
  }

  return true
}

export function transitionPaymentStream(stream, { to, source, occurredAt = new Date().toISOString(), evidence = null }) {
  if (!stream || typeof stream !== 'object') {
    throw new PaymentLifecycleError('Payment stream is required')
  }
  const from = stream.lifecycleState || 'draft'
  assertPaymentTransition({ from, to, source })

  return {
    ...stream,
    lifecycleState: to,
    lifecycleUpdatedAt: occurredAt,
    lifecycleEvidence: evidence,
    lifecycleHistory: [
      ...(Array.isArray(stream.lifecycleHistory) ? stream.lifecycleHistory : []),
      { from, to, source, occurredAt, evidence }
    ]
  }
}
