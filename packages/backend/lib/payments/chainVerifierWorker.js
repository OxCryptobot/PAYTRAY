import { createChainEventProcessor } from './chainEventProcessor.js'

export class ChainVerifierWorkerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ChainVerifierWorkerError'
  }
}

export function createChainVerifierWorker({
  provider,
  adapter,
  tokenRegistry,
  repository,
  getStream,
  projectStream,
  decodeLog,
  loadCursor,
  saveCursor,
  maxBlockRange = 2_000,
  finalityConfirmations = 10
}) {
  if (!provider || typeof provider.getBlockNumber !== 'function' || typeof provider.getLogs !== 'function') {
    throw new ChainVerifierWorkerError('Provider must implement getBlockNumber and getLogs')
  }
  if (typeof decodeLog !== 'function') {
    throw new ChainVerifierWorkerError('Protocol log decoder is required')
  }
  if (typeof getStream !== 'function' || typeof projectStream !== 'function') {
    throw new ChainVerifierWorkerError('Stream lookup and projection callbacks are required')
  }
  if (typeof loadCursor !== 'function' || typeof saveCursor !== 'function') {
    throw new ChainVerifierWorkerError('Durable cursor callbacks are required')
  }
  if (!Number.isSafeInteger(maxBlockRange) || maxBlockRange < 1) {
    throw new ChainVerifierWorkerError('maxBlockRange must be a positive safe integer')
  }
  if (!Number.isSafeInteger(finalityConfirmations) || finalityConfirmations < 1) {
    throw new ChainVerifierWorkerError('finalityConfirmations must be a positive safe integer')
  }

  const processor = createChainEventProcessor({
    adapter,
    tokenRegistry,
    repository,
    projectStream
  })

  return Object.freeze({
    async pollOnce({ fromBlock = null, toBlock = null } = {}) {
      const latestBlock = toBlock == null ? await provider.getBlockNumber() : toBlock
      if (!Number.isSafeInteger(latestBlock) || latestBlock < 0) {
        throw new ChainVerifierWorkerError('Provider returned an invalid latest block')
      }

      const cursor = fromBlock == null ? await loadCursor(adapter.chainId) : fromBlock
      const startBlock = cursor == null ? latestBlock : Number(cursor) + 1
      if (!Number.isSafeInteger(startBlock) || startBlock < 0) {
        throw new ChainVerifierWorkerError('Verifier cursor is invalid')
      }
      if (startBlock > latestBlock) {
        return { chainId: adapter.chainId, fromBlock: startBlock, toBlock: latestBlock, logs: 0, projected: 0, replays: 0 }
      }

      const endBlock = Math.min(latestBlock, startBlock + maxBlockRange - 1)
      const logs = await provider.getLogs({
        address: adapter.contractAddress,
        fromBlock: startBlock,
        toBlock: endBlock
      })
      let projected = 0
      let replays = 0
      let ignored = 0

      for (const log of logs) {
        const event = await decodeLog(log)
        if (!event) {
          ignored += 1
          continue
        }

        const stream = await getStream(event)
        if (!stream) {
          throw new ChainVerifierWorkerError(`No Paytray stream found for protocol stream ${event.streamProtocolId}`)
        }

        const confirmationCount = endBlock - Number(event.blockNumber) + 1
        const finalizedEvent = {
          ...event,
          confirmationCount,
          finalityStatus: confirmationCount >= finalityConfirmations ? 'finalized' : 'included'
        }
        const result = await processor.process({
          stream,
          event: finalizedEvent,
          observedAt: new Date().toISOString()
        })
        if (result.idempotentReplay) replays += 1
        if (result.projected) projected += 1
      }

      await saveCursor(adapter.chainId, endBlock)
      return {
        chainId: adapter.chainId,
        fromBlock: startBlock,
        toBlock: endBlock,
        logs: logs.length,
        projected,
        replays,
        ignored
      }
    }
  })
}
