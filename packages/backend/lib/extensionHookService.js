import { randomUUID } from 'node:crypto'
import { NotFoundError, ValidationError } from './errors.js'

const MAX_LIMIT = 100

function normalizeLimit(value = 100) {
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`)
  return limit
}

function normalizeOwner(value) {
  const owner = String(value || '').trim().toLowerCase()
  if (!owner) throw new ValidationError('ownerWallet is required')
  return owner
}

function toHook(row) {
  if (!row) return null
  return {
    id: row.id,
    ownerWallet: row.owner_wallet,
    apiVersion: row.api_version,
    contractVersion: row.contract_version,
    event: row.event,
    callbackUrl: row.callback_url,
    projections: row.projections,
    replayWindowSeconds: row.replay_window_seconds,
    delivery: row.delivery,
    createdAt: row.created_at
  }
}

export async function registerExtensionHook({ client, ownerWallet, hook }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  if (!hook || typeof hook !== 'object') throw new ValidationError('hook is required')
  const owner = normalizeOwner(ownerWallet)
  const id = `hook-${randomUUID()}`
  const result = await client.query(
    `INSERT INTO extension_hooks (
       id, owner_wallet, api_version, contract_version, event, callback_url,
       projections, replay_window_seconds, delivery
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb)
     RETURNING *`,
    [id, owner, hook.apiVersion, hook.contractVersion, hook.event, hook.callbackUrl, JSON.stringify(hook.projections), hook.replayWindowSeconds, JSON.stringify(hook.delivery)]
  )
  return toHook(result.rows[0])
}

export async function listExtensionHooks({ client, ownerWallet = null, limit = 100 }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const normalizedLimit = normalizeLimit(limit)
  const owner = ownerWallet == null || ownerWallet === '' ? null : normalizeOwner(ownerWallet)
  const result = await client.query(
    `SELECT id, owner_wallet, api_version, contract_version, event, callback_url,
            projections, replay_window_seconds, delivery, created_at
     FROM extension_hooks
     WHERE active = true AND ($1::varchar IS NULL OR owner_wallet = $1)
     ORDER BY created_at ASC, id ASC
     LIMIT $2`,
    [owner, normalizedLimit]
  )
  return result.rows.map(toHook)
}

export async function deactivateExtensionHook({ client, hookId, ownerWallet }) {
  if (!client || typeof client.query !== 'function') throw new ValidationError('client is required')
  const id = String(hookId || '').trim()
  if (!id) throw new ValidationError('hookId is required')
  const owner = normalizeOwner(ownerWallet)
  const result = await client.query(
    `UPDATE extension_hooks
     SET active = false, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND owner_wallet = $2 AND active = true
     RETURNING id`,
    [id, owner]
  )
  if (!result.rows[0]) throw new NotFoundError('Extension hook')
  return { hookId: id, active: false, mutation: 'hook_deactivated', settlementAuthority: false }
}

export { toHook }
