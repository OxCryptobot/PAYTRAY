import { createChainVerifierWorker } from './chainVerifierWorker.js'
import { createFinancialRepository } from './financialRepository.js'
import { createProtocolAdapter } from './protocolAdapter.js'
import { createBaseSepoliaFlowVerifier } from './sablierFlowV3.js'

export function createDatabaseVerifierWorker({ client, provider, adapter, tokenRegistry, decodeLog, maxBlockRange = 2_000, finalityConfirmations = 10, verifierId = 'verifier-worker' }) {
  if (!client || typeof client.query !== 'function') throw new Error('Database client with query method is required')

  const repository = createFinancialRepository(client)
  const loadCursor = async (chainId) => {
    const result = await client.query('SELECT last_scanned_block FROM payment_verifier_cursors WHERE chain_id = $1', [chainId])
    return result.rows[0]?.last_scanned_block == null ? null : Number(result.rows[0].last_scanned_block)
  }
  const saveCursor = async (chainId, lastScannedBlock) => {
    await client.query(
      `INSERT INTO payment_verifier_cursors (chain_id, last_scanned_block)
       VALUES ($1, $2)
       ON CONFLICT (chain_id) DO UPDATE
       SET last_scanned_block = EXCLUDED.last_scanned_block,
           updated_at = CURRENT_TIMESTAMP`,
      [chainId, lastScannedBlock]
    )
  }
  const getStream = async (event) => {
    const result = await client.query(`
      SELECT ps.*, sender.wallet_address AS sender_wallet, recipient.wallet_address AS recipient_wallet
      FROM payment_streams ps
      JOIN users sender ON sender.id = ps.sender_id
      JOIN users recipient ON recipient.id = ps.recipient_id
      WHERE ps.protocol_stream_id = $1
        AND ps.chain_id = $2
      ORDER BY ps.created_at DESC
      LIMIT 1
    `, [event.streamProtocolId, event.chainId])
    const row = result.rows[0]
    if (!row) return null
    return {
      id: row.id,
      lifecycleState: row.lifecycle_state || 'draft',
      chainId: row.chain_id,
      protocolContractAddress: row.protocol_contract_address,
      tokenAddress: row.token_address,
      senderWallet: row.sender_wallet,
      recipientWallet: row.recipient_wallet,
      protocolStreamId: row.protocol_stream_id
    }
  }
  const projectStream = async (stream, metadata) => {
    await client.query(`
      UPDATE payment_streams
      SET lifecycle_state = $1,
          finality_status = $2,
          protocol_stream_id = $3,
          last_verified_event = $4::jsonb,
          lifecycle_updated_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP,
          version = version + 1
      WHERE id = $5
    `, [
      stream.lifecycleState,
      metadata.chainEvent.finality_status || 'observed',
      stream.protocolStreamId || null,
      JSON.stringify({ verifierId, chainEventId: metadata.chainEvent.id, recovery: metadata.recovery === true, observedAt: metadata.observedAt }),
      stream.id
    ])
    await client.query(
      `INSERT INTO financial_audit_events (actor_type, actor_id, action, entity_type, entity_id, metadata)
       VALUES ('verifier', $1, 'payment_chain_event_projected', 'payment_stream', $2, $3::jsonb)`,
      [verifierId, stream.id, JSON.stringify({ chainEventId: metadata.chainEvent.id, recovery: metadata.recovery === true })]
    )
  }

  return createChainVerifierWorker({
    provider,
    adapter,
    tokenRegistry,
    repository,
    getStream,
    projectStream,
    decodeLog,
    loadCursor,
    saveCursor,
    maxBlockRange,
    finalityConfirmations
  })
}

export function createConfiguredBaseSepoliaVerifierWorker({ client, rpcUrl, tokenRegistry, contractAddress, maxBlockRange = 2_000, finalityConfirmations = 10, verifierId = 'verifier-worker' } = {}) {
  const configured = createBaseSepoliaFlowVerifier({ rpcUrl, contractAddress })
  const adapter = createProtocolAdapter({
    protocol: 'sablier-flow-v3',
    chainId: configured.chainId,
    contractAddress: configured.contractAddress,
    tokenRegistry
  })
  return createDatabaseVerifierWorker({
    client,
    provider: configured.provider,
    adapter,
    tokenRegistry,
    decodeLog: configured.decodeLog,
    maxBlockRange,
    finalityConfirmations,
    verifierId
  })
}
