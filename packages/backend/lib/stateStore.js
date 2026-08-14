import fs from 'fs/promises'
import os from 'os'
import path from 'path'

export const STATE_SNAPSHOT_VERSION = 1
const COLLECTION_KEYS = Object.freeze([
  'profiles',
  'paymentStreams',
  'calls',
  'matchSessions',
  'conversationThreads',
  'engagementContracts',
  'trustSignals',
  'offchainLedger',
  'identityLinks',
  'sessionArtifacts',
  'reputationEvents',
  'chainRegistry',
  'paymentCreateIdempotency',
  'queueJobs',
  'extensionHooks',
  'webhookDeliveries'
])

export class StateSnapshotError extends Error {
  constructor(message) {
    super(message)
    this.name = 'StateSnapshotError'
  }
}

async function ensureDirectory(filePath) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
}

export function validateStateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new StateSnapshotError('State snapshot must be an object')
  if (snapshot.version !== STATE_SNAPSHOT_VERSION) throw new StateSnapshotError(`Unsupported state snapshot version: ${snapshot.version}`)
  if (typeof snapshot.updatedAt !== 'string' || Number.isNaN(Date.parse(snapshot.updatedAt))) throw new StateSnapshotError('State snapshot updatedAt must be an ISO timestamp')
  for (const key of COLLECTION_KEYS) {
    if (snapshot[key] !== undefined && !Array.isArray(snapshot[key])) throw new StateSnapshotError(`State snapshot ${key} must be an array`)
  }
  return snapshot
}

async function quarantineSnapshot(filePath) {
  const quarantinePath = `${filePath}.invalid-${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    await fs.rename(filePath, quarantinePath)
    return quarantinePath
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function loadStateSnapshot(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      await quarantineSnapshot(filePath)
      return null
    }
    try {
      return validateStateSnapshot(parsed)
    } catch (error) {
      if (!(error instanceof StateSnapshotError)) throw error
      await quarantineSnapshot(filePath)
      return null
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

export async function saveStateSnapshot(filePath, snapshot) {
  validateStateSnapshot(snapshot)
  await ensureDirectory(filePath)
  const tempPath = path.join(os.tmpdir(), `paytray-state-${process.pid}-${Date.now()}.tmp`)
  try {
    await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tempPath, filePath)
  } finally {
    await fs.rm(tempPath, { force: true })
  }
}

export default {
  loadStateSnapshot,
  saveStateSnapshot,
  validateStateSnapshot
}
