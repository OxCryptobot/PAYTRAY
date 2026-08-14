export class FinancialRepositoryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'FinancialRepositoryError'
  }
}

function requireValue(value, fieldName) {
  if (value == null || value === '') {
    throw new FinancialRepositoryError(`${fieldName} is required`)
  }
  return value
}

function requireBaseUnitAmount(value, fieldName) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new FinancialRepositoryError(`${fieldName} must be a base-unit integer string`)
  }
  return value
}

export function createFinancialRepository(client) {
  if (!client || typeof client.query !== 'function') {
    throw new FinancialRepositoryError('Database client with query method is required')
  }

  return Object.freeze({
    async createPaymentIntent(intent) {
      const result = await client.query(
        `INSERT INTO payment_intents (
          engagement_id, sender_id, recipient_id, intent_type, stream_id,
          chain_id, token_address, token_decimals, amount_base_units,
          rate_per_second_base_units, idempotency_key, request_hash, status
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12, 'intent_created'
        )
        RETURNING *`,
        [
          intent.engagementId || null,
          requireValue(intent.senderId, 'senderId'),
          requireValue(intent.recipientId, 'recipientId'),
          requireValue(intent.intentType, 'intentType'),
          intent.streamId || null,
          requireValue(intent.chainId, 'chainId'),
          requireValue(intent.tokenAddress, 'tokenAddress'),
          requireValue(intent.tokenDecimals, 'tokenDecimals'),
          intent.amountBaseUnits == null ? null : requireBaseUnitAmount(intent.amountBaseUnits, 'amountBaseUnits'),
          intent.ratePerSecondBaseUnits == null ? null : requireBaseUnitAmount(intent.ratePerSecondBaseUnits, 'ratePerSecondBaseUnits'),
          requireValue(intent.idempotencyKey, 'idempotencyKey'),
          requireValue(intent.requestHash, 'requestHash')
        ]
      )
      return result.rows[0]
    },

    async findPaymentIntentByIdempotency({ senderId, idempotencyKey }) {
      const result = await client.query(
        'SELECT * FROM payment_intents WHERE sender_id = $1 AND idempotency_key = $2',
        [requireValue(senderId, 'senderId'), requireValue(idempotencyKey, 'idempotencyKey')]
      )
      return result.rows[0] || null
    },

    async recordChainEvent(event) {
      const insert = await client.query(
        `INSERT INTO payment_chain_events (
          stream_id, intent_id, chain_id, protocol_contract_address,
          transaction_hash, block_number, block_hash, log_index,
          event_name, event_payload, event_payload_hash, confirmation_count,
          finality_status, correlation_id
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8,
          $9, $10::jsonb, $11, $12,
          $13, $14
        )
        ON CONFLICT (chain_id, transaction_hash, log_index) DO NOTHING
        RETURNING *`,
        [
          event.streamId || null,
          event.intentId || null,
          requireValue(event.chainId, 'chainId'),
          requireValue(event.protocolContractAddress, 'protocolContractAddress'),
          requireValue(event.transactionHash, 'transactionHash'),
          requireValue(event.blockNumber, 'blockNumber'),
          requireValue(event.blockHash, 'blockHash'),
          requireValue(event.logIndex, 'logIndex'),
          requireValue(event.eventName, 'eventName'),
          JSON.stringify(event.payload || {}),
          requireValue(event.payloadHash, 'payloadHash'),
          Number(event.confirmationCount || 0),
          requireValue(event.finalityStatus, 'finalityStatus'),
          event.correlationId || null
        ]
      )
      if (insert.rows[0]) return { event: insert.rows[0], idempotentReplay: false }

      const existing = await client.query(
        `SELECT * FROM payment_chain_events
         WHERE chain_id = $1 AND transaction_hash = $2 AND log_index = $3`,
        [event.chainId, event.transactionHash, event.logIndex]
      )
      return { event: existing.rows[0] || null, idempotentReplay: true }
    },

    async appendLedgerEntry(entry) {
      if (!entry.sourceChainEventId && !entry.sourceIntentId) {
        throw new FinancialRepositoryError('Ledger entry requires a source chain event or payment intent')
      }
      const sourceChainEventId = entry.sourceChainEventId || null
      const sourceIntentId = entry.sourceIntentId || null
      const entryType = requireValue(entry.entryType, 'entryType')
      const result = await client.query(
        `INSERT INTO ledger_entries (
          source_chain_event_id, source_intent_id, debit_account_id, credit_account_id,
          entry_type, amount_base_units, chain_id, token_address, correlation_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
        RETURNING *`,
        [
          sourceChainEventId,
          sourceIntentId,
          requireValue(entry.debitAccountId, 'debitAccountId'),
          requireValue(entry.creditAccountId, 'creditAccountId'),
          entryType,
          requireBaseUnitAmount(entry.amountBaseUnits, 'amountBaseUnits'),
          requireValue(entry.chainId, 'chainId'),
          requireValue(entry.tokenAddress, 'tokenAddress'),
          entry.correlationId || null
        ]
      )
      if (result.rows[0]) return { entry: result.rows[0], idempotentReplay: false }

      const existing = await client.query(
        `SELECT * FROM ledger_entries
         WHERE entry_type = $1
           AND (($2::uuid IS NOT NULL AND source_chain_event_id = $2::uuid)
             OR ($3::uuid IS NOT NULL AND source_intent_id = $3::uuid))
         LIMIT 1`,
        [entryType, sourceChainEventId, sourceIntentId]
      )
      if (!existing.rows[0]) throw new FinancialRepositoryError('Ledger entry replay could not be resolved')
      return { entry: existing.rows[0], idempotentReplay: true }
    }
  })
}
