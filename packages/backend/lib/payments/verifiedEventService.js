import { createChainEventProcessor } from './chainEventProcessor.js'
import { createFinancialRepository } from './financialRepository.js'
import { createProtocolAdapter } from './protocolAdapter.js'
import { NotFoundError, ValidationError } from '../errors.js'
import { enqueueOutboxEvent } from '../outboxDeliveryService.js'

function toStream(row) {
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

async function loadOrProvisionStream({ client, tokenRegistry, config, streamId, intentId, event }) {
  if (streamId) {
    const streamResult = await client.query(`
      SELECT ps.*, sender.wallet_address AS sender_wallet, recipient.wallet_address AS recipient_wallet
      FROM payment_streams ps
      JOIN users sender ON sender.id = ps.sender_id
      JOIN users recipient ON recipient.id = ps.recipient_id
      WHERE ps.id = $1
      FOR UPDATE
    `, [streamId])
    if (!streamResult.rows[0]) throw new NotFoundError('Payment stream')
    return streamResult.rows[0]
  }

  if (!intentId) throw new ValidationError('streamId or intentId is required')
  if (event?.type !== 'stream_created') throw new ValidationError('Only stream_created evidence can provision a stream from an intent')
  const intentResult = await client.query(`
    SELECT pi.*, sender.wallet_address AS sender_wallet, recipient.wallet_address AS recipient_wallet
    FROM payment_intents pi
    JOIN users sender ON sender.id = pi.sender_id
    JOIN users recipient ON recipient.id = pi.recipient_id
    WHERE pi.id = $1
    FOR UPDATE
  `, [intentId])
  if (!intentResult.rows[0]) throw new NotFoundError('Payment intent')
  const intent = intentResult.rows[0]
  const token = tokenRegistry.requireEnabled(event.chainId, event.tokenAddress)
  const created = await client.query(`
    INSERT INTO payment_streams (
      sender_id, recipient_id, token_symbol, amount, duration_seconds,
      status, amount_withdrawn, engagement_id, lifecycle_state, finality_status,
      source, protocol_name, protocol_version, protocol_contract_address,
      chain_id, token_address, token_decimals, amount_base_units,
      version, correlation_id, lifecycle_updated_at
    ) VALUES (
      $1, $2, $3, ($4::numeric / power(10::numeric, $5::integer)),
      COALESCE(floor($4::numeric / NULLIF($6::numeric, 0)), 0)::integer,
      'active', 0, $7, 'wallet_submitted', 'unverified',
      'verifier', $8, 'v3', $9, $10, $11, $5, $4, 1, $12, CURRENT_TIMESTAMP
    )
    RETURNING *
  `, [
    intent.sender_id,
    intent.recipient_id,
    token.symbol,
    intent.amount_base_units,
    token.decimals,
    intent.rate_per_second_base_units,
    intent.engagement_id,
    config.payments.protocol,
    event.protocolContractAddress,
    event.chainId,
    token.address,
    intent.correlation_id
  ])
  const row = created.rows[0]
  await client.query(
    `UPDATE payment_intents
     SET stream_id = $1,
         transaction_hash = $2,
         status = 'chain_pending',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3`,
    [row.id, event.transactionHash, intentId]
  )
  return { ...row, sender_wallet: intent.sender_wallet, recipient_wallet: intent.recipient_wallet }
}

export async function processVerifiedChainEvent({ client, config, tokenRegistry, streamId = null, intentId = null, event, verifierId }) {
  if (!verifierId) throw new ValidationError('verifierId is required')
  const streamRow = await loadOrProvisionStream({ client, tokenRegistry, config, streamId, intentId, event })
  const stream = toStream(streamRow)
  if (!config.payments.protocolContractAddress) throw new ValidationError('Payment protocol contract is not configured')

  const adapter = createProtocolAdapter({
    protocol: config.payments.protocol,
    chainId: config.payments.settlementChainId,
    contractAddress: config.payments.protocolContractAddress,
    tokenRegistry
  })
  const repository = createFinancialRepository(client)
  const processor = createChainEventProcessor({
    adapter,
    tokenRegistry,
    repository,
    async projectStream(projectedStream, metadata) {
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
        projectedStream.lifecycleState,
        metadata.chainEvent.finality_status || event.finalityStatus,
        projectedStream.protocolStreamId || null,
        JSON.stringify({
          verifierId: String(verifierId),
          chainEventId: metadata.chainEvent.id,
          eventType: event.type,
          finalityStatus: event.finalityStatus,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          blockHash: event.blockHash,
          logIndex: event.logIndex,
          observedAt: metadata.observedAt,
          recovery: metadata.recovery === true
        }),
        stream.id
      ])
    }
  })

  const result = await processor.process({ stream, event, intentId, correlationId: null })
  const auditResult = await client.query(
    `INSERT INTO financial_audit_events (actor_type, actor_id, action, entity_type, entity_id, metadata)
     VALUES ('verifier', $1, $2, 'payment_stream', $3, $4::jsonb)
     RETURNING id`,
    [String(verifierId), result.idempotentReplay ? 'payment_chain_event_replayed' : 'payment_chain_event_projected', stream.id, JSON.stringify({ chainEventId: result.chainEvent?.id || null, projected: result.projected, finalityStatus: event.finalityStatus })]
  )
  await enqueueOutboxEvent({
    client,
    aggregateType: 'payment_stream',
    aggregateId: stream.id,
    eventType: result.idempotentReplay ? 'payment.chain_event.replayed' : 'payment.chain_event.projected',
    correlationId: result.chainEvent?.correlation_id || null,
    payload: {
      auditEventId: auditResult.rows[0]?.id || null,
      chainEventId: result.chainEvent?.id || null,
      streamId: stream.id,
      finalityStatus: event.finalityStatus,
      projected: result.projected === true,
      deliveryAuthority: 'durable_outbox_only'
    }
  })
  return result
}
