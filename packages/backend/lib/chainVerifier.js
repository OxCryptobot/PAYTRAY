// Receipt-based on-chain verification. The provider is injected (ethers JsonRpcProvider-compatible:
// getTransactionReceipt, getBlockNumber) so the logic is testable and chain-agnostic.

export class ChainVerifier {
  constructor(provider, { minConfirmations = 3 } = {}) {
    this.provider = provider
    this.minConfirmations = minConfirmations
  }

  // status: not_found | reverted | included | confirmed (enough confirmations)
  async verify(txHash, { expectedTo = null } = {}) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) {
      return { status: 'invalid', reason: 'malformed_hash' }
    }
    const receipt = await this.provider.getTransactionReceipt(txHash)
    if (!receipt) return { status: 'not_found' }
    if (receipt.status === 0) return { status: 'reverted', blockNumber: receipt.blockNumber }
    if (expectedTo && String(receipt.to || '').toLowerCase() !== String(expectedTo).toLowerCase()) {
      return { status: 'mismatch', reason: 'unexpected_recipient', blockNumber: receipt.blockNumber }
    }
    const head = await this.provider.getBlockNumber()
    const confirmations = Math.max(0, head - receipt.blockNumber + 1)
    return {
      status: confirmations >= this.minConfirmations ? 'confirmed' : 'included',
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash || null,
      confirmations
    }
  }

  // A previously confirmed tx whose receipt block hash changed (or vanished) was reorged out.
  async detectReorg(txHash, recordedBlockHash) {
    const receipt = await this.provider.getTransactionReceipt(txHash)
    if (!receipt) return { reorged: true, reason: 'receipt_missing' }
    if (recordedBlockHash && receipt.blockHash && receipt.blockHash !== recordedBlockHash) {
      return { reorged: true, reason: 'block_hash_changed' }
    }
    return { reorged: false }
  }
}

export default ChainVerifier
