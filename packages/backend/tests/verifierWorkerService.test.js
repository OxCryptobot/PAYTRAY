import { describe, expect, it } from 'vitest'
import { createProtocolAdapter } from '../lib/payments/protocolAdapter.js'
import { createTokenRegistry } from '../lib/payments/tokenRegistry.js'
import { createDatabaseVerifierWorker } from '../lib/payments/verifierWorkerService.js'

const token = {
  chainId: 84532,
  address: '0x1111111111111111111111111111111111111111',
  decimals: 6,
  symbol: 'USDC',
  protocolContractAddress: '0xc1ba5a41936aaab0ff920446db556efe17fc1c5d'
}

const stream = {
  id: '00000000-0000-4000-8000-000000000010',
  lifecycle_state: 'wallet_submitted',
  chain_id: 84532,
  protocol_contract_address: token.protocolContractAddress,
  token_address: token.address,
  protocol_stream_id: '42',
  sender_wallet: '0x2222222222222222222222222222222222222222',
  recipient_wallet: '0x3333333333333333333333333333333333333333'
}

function eventLog() {
  return { blockNumber: 101, transactionHash: `0x${'a'.repeat(64)}`, blockHash: `0x${'b'.repeat(64)}`, logIndex: 0 }
}

describe('database verifier worker service', () => {
  it('loads and saves a bounded cursor and projects a decoded event', async () => {
    const calls = []
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({ protocol: 'sablier-flow-v3', chainId: 84532, contractAddress: token.protocolContractAddress, tokenRegistry: registry })
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT last_scanned_block')) return { rows: [{ last_scanned_block: '100' }] }
        if (sql.includes('FROM payment_streams')) return { rows: [stream] }
        if (sql.includes('INSERT INTO payment_chain_events')) return { rows: [{ id: 'event-1', finality_status: 'included' }] }
        if (sql.includes('UPDATE payment_streams')) return { rows: [{ id: stream.id }] }
        if (sql.includes('INSERT INTO financial_audit_events')) return { rows: [{ id: 'audit-1' }] }
        if (sql.includes('INSERT INTO payment_verifier_cursors')) return { rows: [{ chain_id: 84532, last_scanned_block: 101 }] }
        throw new Error(`Unexpected query: ${sql}`)
      }
    }
    const worker = createDatabaseVerifierWorker({
      client,
      provider: { async getBlockNumber() { return 101 }, async getLogs() { return [eventLog()] } },
      adapter,
      tokenRegistry: registry,
      decodeLog: async () => ({
        type: 'stream_created', finalityStatus: 'included', streamProtocolId: '42', chainId: 84532,
        protocolContractAddress: token.protocolContractAddress, tokenAddress: token.address,
        senderWallet: stream.sender_wallet, recipientWallet: stream.recipient_wallet,
        transactionHash: eventLog().transactionHash, blockNumber: 101, blockHash: eventLog().blockHash,
        logIndex: 0, amountBaseUnits: '10000000', rawPayload: {}
      })
    })
    const result = await worker.pollOnce()
    expect(result).toMatchObject({ fromBlock: 101, toBlock: 101, logs: 1, projected: 1, replays: 0 })
    expect(calls.some((call) => call.sql.includes('INSERT INTO payment_verifier_cursors'))).toBe(true)
    expect(calls.some((call) => call.sql.includes('INSERT INTO financial_audit_events'))).toBe(true)
  })

  it('does not query the chain when the durable cursor is already current', async () => {
    let queried = false
    const registry = createTokenRegistry([token])
    const adapter = createProtocolAdapter({ protocol: 'sablier-flow-v3', chainId: 84532, contractAddress: token.protocolContractAddress, tokenRegistry: registry })
    const worker = createDatabaseVerifierWorker({
      client: { async query(sql) { if (sql.includes('SELECT last_scanned_block')) return { rows: [{ last_scanned_block: '101' }] }; throw new Error(`Unexpected query: ${sql}`) } },
      provider: { async getBlockNumber() { return 101 }, async getLogs() { queried = true; return [] } },
      adapter,
      tokenRegistry: registry,
      decodeLog: async () => null
    })
    const result = await worker.pollOnce()
    expect(result.logs).toBe(0)
    expect(queried).toBe(false)
  })
})
