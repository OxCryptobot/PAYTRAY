import { PaymentLifecycleError, transitionPaymentStream } from './paymentLifecycle.js'
import { ProtocolAdapterError, assertEventMatchesStream } from './protocolAdapter.js'

export class VerifierServiceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VerifierServiceError'
  }
}

function applyTransition(stream, to, event) {
  if (stream.lifecycleState === to) return stream
  return transitionPaymentStream(stream, {
    to,
    source: 'verifier',
    occurredAt: event.observedAt || new Date().toISOString(),
    evidence: {
      chainId: event.chainId,
      protocolContractAddress: event.protocolContractAddress,
      streamProtocolId: event.streamProtocolId,
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber,
      blockHash: event.blockHash,
      logIndex: event.logIndex,
      eventType: event.type,
      finalityStatus: event.finalityStatus
    }
  })
}

function bridgeToIncluded(stream, event) {
  let next = stream
  if (next.lifecycleState === 'wallet_submitted') {
    next = applyTransition(next, 'chain_pending', event)
  }
  if (next.lifecycleState === 'chain_pending') {
    next = applyTransition(next, 'chain_included', event)
  }
  return next
}

function bridgeToFinalized(stream, event) {
  let next = bridgeToIncluded(stream, event)
  if (next.lifecycleState === 'chain_included') {
    next = applyTransition(next, 'chain_finalized', event)
  }
  return next
}

export function applyVerifiedProtocolEvent({ stream, event, tokenRegistry, observedAt }) {
  try {
    assertEventMatchesStream(stream, event, tokenRegistry)

    const baseStream = {
      ...stream,
      protocolStreamId: event.streamProtocolId,
      lastVerifiedEvent: {
        type: event.type,
        finalityStatus: event.finalityStatus,
        transactionHash: event.transactionHash,
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        logIndex: event.logIndex,
        observedAt: observedAt || new Date().toISOString()
      }
    }
    const verifierEvent = { ...event, observedAt: observedAt || new Date().toISOString() }

    if (event.finalityStatus === 'observed') {
      if (baseStream.lifecycleState !== 'wallet_submitted') {
        throw new VerifierServiceError(`Observed event cannot be applied from ${baseStream.lifecycleState}`)
      }
      return applyTransition(baseStream, 'chain_pending', verifierEvent)
    }

    if (event.finalityStatus === 'included') {
      return bridgeToIncluded(baseStream, verifierEvent)
    }

    if (event.finalityStatus === 'finalized') {
      return bridgeToFinalized(baseStream, verifierEvent)
    }

    if (event.finalityStatus === 'reorged' || event.finalityStatus === 'invalid') {
      if (!['chain_pending', 'chain_included', 'chain_finalized'].includes(baseStream.lifecycleState)) {
        throw new VerifierServiceError(`Invalidated event cannot be applied from ${baseStream.lifecycleState}`)
      }
      return applyTransition(baseStream, 'failed', verifierEvent)
    }

    throw new VerifierServiceError(`Unsupported verifier finality status: ${event.finalityStatus}`)
  } catch (error) {
    if (error instanceof PaymentLifecycleError || error instanceof ProtocolAdapterError) {
      throw new VerifierServiceError(error.message)
    }
    throw error
  }
}
