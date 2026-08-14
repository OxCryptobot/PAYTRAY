import crypto from 'crypto'
import { applyVerifiedProtocolEvent } from './verifierService.js'

export class ChainEventProcessorError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ChainEventProcessorError'
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key])
      return result
    }, {})
  }
  return value
}

export function hashEventPayload(payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(payload || {})))
    .digest('hex')
}

function isStaleNonFinalityEvent(stream, event) {
  const currentFinality = stream.lastVerifiedEvent?.finalityStatus
  return currentFinality === 'finalized' && ['observed', 'included'].includes(event.finalityStatus)
}

function isLifecycleProjectionAlreadyApplied(stream, event) {
  const appliedStates = {
    observed: ['chain_pending', 'chain_included', 'chain_finalized'],
    included: ['chain_included', 'chain_finalized'],
    finalized: ['chain_finalized'],
    reorged: ['failed'],
    invalid: ['failed']
  }
  return appliedStates[event.finalityStatus]?.includes(stream.lifecycleState) || false
}

export function createChainEventProcessor({ adapter, tokenRegistry, repository, projectStream }) {
  if (!adapter || typeof adapter.validateEvent !== 'function') {
    throw new ChainEventProcessorError('Protocol adapter with validateEvent is required')
  }
  if (!repository || typeof repository.recordChainEvent !== 'function') {
    throw new ChainEventProcessorError('Financial repository with recordChainEvent is required')
  }
  if (typeof projectStream !== 'function') {
    throw new ChainEventProcessorError('Project-stream persistence callback is required')
  }

  return Object.freeze({
    async process({ stream, event, intentId = null, correlationId = null, observedAt = new Date().toISOString() }) {
      if (!stream?.id) {
        throw new ChainEventProcessorError('Durable payment stream id is required')
      }

      const normalizedEvent = adapter.validateEvent(event)
      if (isStaleNonFinalityEvent(stream, normalizedEvent)) {
        return Object.freeze({
          chainEvent: null,
          stream,
          idempotentReplay: true,
          projected: false,
          ignored: true,
          reason: 'stale_non_finality_event'
        })
      }
      const persistence = await repository.recordChainEvent({
        streamId: stream.id,
        intentId,
        chainId: normalizedEvent.chainId,
        protocolContractAddress: normalizedEvent.protocolContractAddress,
        transactionHash: normalizedEvent.transactionHash,
        blockNumber: normalizedEvent.blockNumber,
        blockHash: normalizedEvent.blockHash,
        logIndex: normalizedEvent.logIndex,
        eventName: normalizedEvent.type,
        payload: normalizedEvent.rawPayload,
        payloadHash: hashEventPayload(normalizedEvent.rawPayload),
        confirmationCount: event.confirmationCount || 0,
        finalityStatus: normalizedEvent.finalityStatus,
        correlationId
      })

      if (persistence.idempotentReplay && isLifecycleProjectionAlreadyApplied(stream, normalizedEvent)) {
        return Object.freeze({
          chainEvent: persistence.event,
          stream,
          idempotentReplay: true,
          projected: false
        })
      }

      if (persistence.idempotentReplay) {
        const replayedStream = applyVerifiedProtocolEvent({
          stream,
          event: normalizedEvent,
          tokenRegistry,
          observedAt
        })
        const replayNeedsProjection = replayedStream.lifecycleState !== stream.lifecycleState
        if (replayNeedsProjection) {
          await projectStream(replayedStream, {
            chainEvent: persistence.event,
            correlationId,
            observedAt,
            recovery: true
          })
        }
        return Object.freeze({
          chainEvent: persistence.event,
          stream: replayedStream,
          idempotentReplay: true,
          projected: replayNeedsProjection
        })
      }

      const projectedStream = applyVerifiedProtocolEvent({
        stream,
        event: normalizedEvent,
        tokenRegistry,
        observedAt
      })
      await projectStream(projectedStream, {
        chainEvent: persistence.event,
        correlationId,
        observedAt
      })

      return Object.freeze({
        chainEvent: persistence.event,
        stream: projectedStream,
        idempotentReplay: false,
        projected: true
      })
    }
  })
}
