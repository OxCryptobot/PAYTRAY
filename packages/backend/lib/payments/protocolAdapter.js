import { getAddress, isAddress } from 'ethers'

export const PROTOCOL_EVENT_TYPES = Object.freeze([
  'stream_created',
  'stream_topped_up',
  'stream_refunded',
  'stream_paused',
  'stream_restarted',
  'stream_voided',
  'withdrawal'
])

export const CHAIN_FINALITY_STATUSES = Object.freeze([
  'observed',
  'included',
  'finalized',
  'reorged',
  'invalid'
])

export class ProtocolAdapterError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProtocolAdapterError'
  }
}

function requirePositiveInteger(value, fieldName) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || !Number.isSafeInteger(parsed)) {
    throw new ProtocolAdapterError(`${fieldName} must be a non-negative safe integer`)
  }
  return parsed
}

function requireAddress(value, fieldName) {
  if (!isAddress(value)) {
    throw new ProtocolAdapterError(`${fieldName} must be a valid EVM address`)
  }
  return getAddress(value)
}

function requireHash(value, fieldName) {
  if (typeof value !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new ProtocolAdapterError(`${fieldName} must be a 32-byte hex hash`)
  }
  return value.toLowerCase()
}

export function normalizeProtocolEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new ProtocolAdapterError('Protocol event is required')
  }
  if (!PROTOCOL_EVENT_TYPES.includes(event.type)) {
    throw new ProtocolAdapterError('Protocol event type is unsupported')
  }
  if (!CHAIN_FINALITY_STATUSES.includes(event.finalityStatus)) {
    throw new ProtocolAdapterError('Protocol event finality status is unsupported')
  }
  if (typeof event.streamProtocolId !== 'string' || !event.streamProtocolId.trim()) {
    throw new ProtocolAdapterError('Protocol stream id is required')
  }
  if (typeof event.amountBaseUnits !== 'string' || !/^\d+$/.test(event.amountBaseUnits)) {
    throw new ProtocolAdapterError('Amount must be a base-unit integer string')
  }

  return Object.freeze({
    type: event.type,
    finalityStatus: event.finalityStatus,
    streamProtocolId: event.streamProtocolId.trim(),
    chainId: requirePositiveInteger(event.chainId, 'chainId'),
    protocolContractAddress: requireAddress(event.protocolContractAddress, 'Protocol contract address'),
    tokenAddress: requireAddress(event.tokenAddress, 'Token address'),
    senderWallet: requireAddress(event.senderWallet, 'Sender wallet'),
    recipientWallet: requireAddress(event.recipientWallet, 'Recipient wallet'),
    transactionHash: requireHash(event.transactionHash, 'Transaction hash'),
    blockNumber: requirePositiveInteger(event.blockNumber, 'Block number'),
    blockHash: requireHash(event.blockHash, 'Block hash'),
    logIndex: requirePositiveInteger(event.logIndex, 'Log index'),
    amountBaseUnits: event.amountBaseUnits,
    rawPayload: event.rawPayload || {}
  })
}

export function assertEventMatchesStream(stream, event, tokenRegistry) {
  if (!stream || typeof stream !== 'object') {
    throw new ProtocolAdapterError('Payment stream is required')
  }

  const token = tokenRegistry.requireEnabled(event.chainId, event.tokenAddress)
  const checks = [
    ['chainId', Number(stream.chainId), event.chainId],
    ['protocolContractAddress', stream.protocolContractAddress, event.protocolContractAddress],
    ['tokenAddress', stream.tokenAddress, event.tokenAddress],
    ['senderWallet', stream.senderWallet, event.senderWallet],
    ['recipientWallet', stream.recipientWallet, event.recipientWallet]
  ]

  for (const [field, expected, actual] of checks) {
    if (expected == null) continue
    if (String(expected).toLowerCase() !== String(actual).toLowerCase()) {
      throw new ProtocolAdapterError(`Protocol event ${field} does not match the payment stream`)
    }
  }

  if (token.protocolContractAddress && token.protocolContractAddress.toLowerCase() !== event.protocolContractAddress.toLowerCase()) {
    throw new ProtocolAdapterError('Token registry protocol contract does not match the event')
  }

  return token
}

export function createProtocolAdapter({ protocol, chainId, contractAddress, tokenRegistry }) {
  if (typeof protocol !== 'string' || !protocol.trim()) {
    throw new ProtocolAdapterError('Protocol name is required')
  }
  const normalizedChainId = requirePositiveInteger(chainId, 'chainId')
  const normalizedContractAddress = requireAddress(contractAddress, 'Protocol contract address')

  return Object.freeze({
    protocol: protocol.trim(),
    chainId: normalizedChainId,
    contractAddress: normalizedContractAddress,
    validateEvent(event) {
      const normalized = normalizeProtocolEvent(event)
      if (normalized.chainId !== normalizedChainId) {
        throw new ProtocolAdapterError('Protocol event chain does not match the adapter')
      }
      if (normalized.protocolContractAddress.toLowerCase() !== normalizedContractAddress.toLowerCase()) {
        throw new ProtocolAdapterError('Protocol event contract does not match the adapter')
      }
      tokenRegistry.requireEnabled(normalized.chainId, normalized.tokenAddress)
      return normalized
    }
  })
}
