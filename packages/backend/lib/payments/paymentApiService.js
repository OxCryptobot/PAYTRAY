import { getAddress, isAddress } from 'ethers'
import crypto from 'crypto'
import { ConflictError, NotFoundError, ValidationError } from '../errors.js'
import { hashEventPayload } from './chainEventProcessor.js'

function required(value, fieldName) {
  if (value == null || value === '') {
    throw new ValidationError(`${fieldName} is required`)
  }
  return value
}

function wallet(value, fieldName) {
  if (!isAddress(value)) {
    throw new ValidationError(`${fieldName} must be a valid wallet address`)
  }
  return getAddress(value)
}

function baseUnits(value, fieldName) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ValidationError(`${fieldName} must be an exact non-negative base-unit integer string`)
  }
  return value
}

function requestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function ensureUser(client, walletAddress) {
  const existing = await client.query(
    'SELECT id, wallet_address FROM users WHERE wallet_address = $1',
    [walletAddress.toLowerCase()]
  )
  if (existing.rows[0]) return existing.rows[0]

  const created = await client.query(
    `INSERT INTO users (wallet_address, wallet_type, last_login)
     VALUES ($1, 'injected', CURRENT_TIMESTAMP)
     ON CONFLICT (wallet_address) DO UPDATE SET last_login = CURRENT_TIMESTAMP
     RETURNING id, wallet_address`,
    [walletAddress.toLowerCase()]
  )
  return created.rows[0]
}

export function normalizePaymentIntentInput({ senderWallet, recipientWallet, chainId, tokenAddress, amountBaseUnits, ratePerSecondBaseUnits, idempotencyKey, engagementId = null }) {
  const normalizedSender = wallet(senderWallet, 'senderWallet')
  const normalizedRecipient = wallet(recipientWallet, 'recipientWallet')
  if (normalizedSender.toLowerCase() === normalizedRecipient.toLowerCase()) {
    throw new ValidationError('Sender and recipient wallets must be different')
  }

  const numericChainId = Number(chainId)
  if (!Number.isSafeInteger(numericChainId) || numericChainId <= 0) {
    throw new ValidationError('chainId must be a positive integer')
  }

  if (!isAddress(tokenAddress)) {
    throw new ValidationError('tokenAddress must be a valid ERC-20 contract address')
  }

  const normalizedIdempotencyKey = String(required(idempotencyKey, 'idempotencyKey')).trim()
  if (normalizedIdempotencyKey.length < 8 || normalizedIdempotencyKey.length > 128) {
    throw new ValidationError('idempotencyKey must contain 8-128 characters')
  }

  return {
    senderWallet: normalizedSender,
    recipientWallet: normalizedRecipient,
    chainId: numericChainId,
    tokenAddress: getAddress(tokenAddress),
    amountBaseUnits: baseUnits(required(amountBaseUnits, 'amountBaseUnits'), 'amountBaseUnits'),
    ratePerSecondBaseUnits: ratePerSecondBaseUnits == null ? null : baseUnits(ratePerSecondBaseUnits, 'ratePerSecondBaseUnits'),
    idempotencyKey: normalizedIdempotencyKey,
    engagementId: engagementId || null
  }
}

export async function createPaymentIntentV2({ client, tokenRegistry, input }) {
  const normalized = normalizePaymentIntentInput(input)
  let token
  try {
    token = tokenRegistry.requireEnabled(normalized.chainId, normalized.tokenAddress)
  } catch (error) {
    throw new ValidationError(error.message)
  }
  const hash = requestHash({
    ...normalized,
    tokenAddress: token.address,
    decimals: token.decimals
  })

  const existing = await client.query(
    `SELECT * FROM payment_intents
     WHERE sender_id = (SELECT id FROM users WHERE wallet_address = $1)
       AND idempotency_key = $2`,
    [normalized.senderWallet.toLowerCase(), normalized.idempotencyKey]
  )
  if (existing.rows[0]) {
    if (existing.rows[0].request_hash !== hash) {
      throw new ConflictError('Idempotency key reuse with different payment intent')
    }
    return {
      intent: existing.rows[0],
      idempotentReplay: true,
      source: 'durable_payment_intent',
      finalityStatus: 'unverified',
      nextAction: 'wallet_submit'
    }
  }

  const sender = await ensureUser(client, normalized.senderWallet)
  const recipient = await ensureUser(client, normalized.recipientWallet)
  const result = await client.query(
    `INSERT INTO payment_intents (
      engagement_id, sender_id, recipient_id, intent_type, chain_id,
      token_address, token_decimals, amount_base_units,
      rate_per_second_base_units, idempotency_key, request_hash, status
    ) VALUES ($1, $2, $3, 'create_stream', $4, $5, $6, $7, $8, $9, $10, 'intent_created')
    RETURNING *`,
    [
      normalized.engagementId,
      sender.id,
      recipient.id,
      normalized.chainId,
      token.address,
      token.decimals,
      normalized.amountBaseUnits,
      normalized.ratePerSecondBaseUnits,
      normalized.idempotencyKey,
      hash
    ]
  )

  return {
    intent: result.rows[0],
    idempotentReplay: false,
    source: 'durable_payment_intent',
    finalityStatus: 'unverified',
    nextAction: 'wallet_submit'
  }
}

export async function getPaymentIntentV2({ client, intentId, walletAddress }) {
  const result = await client.query(
    `SELECT pi.*
     FROM payment_intents pi
     JOIN users sender ON sender.id = pi.sender_id
     JOIN users recipient ON recipient.id = pi.recipient_id
     WHERE pi.id = $1
       AND (sender.wallet_address = $2 OR recipient.wallet_address = $2)`,
    [required(intentId, 'intentId'), wallet(walletAddress, 'walletAddress').toLowerCase()]
  )
  if (!result.rows[0]) throw new NotFoundError('Payment intent')
  return result.rows[0]
}

export async function listPaymentStreamsV2({ client, walletAddress }) {
  const result = await client.query(
    `SELECT ps.*, sender.wallet_address AS sender_wallet, recipient.wallet_address AS recipient_wallet
     FROM payment_streams ps
     JOIN users sender ON sender.id = ps.sender_id
     JOIN users recipient ON recipient.id = ps.recipient_id
     WHERE sender.wallet_address = $1 OR recipient.wallet_address = $1
     ORDER BY ps.created_at DESC`,
    [wallet(walletAddress, 'walletAddress').toLowerCase()]
  )
  return result.rows.map((stream) => ({
    ...stream,
    source: stream.source || 'legacy',
    finalityStatus: stream.finality_status || 'unverified',
    lifecycleState: stream.lifecycle_state || 'legacy'
  }))
}

export { hashEventPayload }
