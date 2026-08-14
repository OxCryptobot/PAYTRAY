import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { loadStateSnapshot, saveStateSnapshot, validateStateSnapshot } from '../lib/stateStore.js'

describe('state store recovery', () => {
  it('validates a versioned snapshot and persists it atomically', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-state-test-'))
    const filePath = path.join(directory, 'runtime-state.json')
    const snapshot = { version: 1, updatedAt: new Date().toISOString(), profiles: [], webhookDeliveries: [] }

    await saveStateSnapshot(filePath, snapshot)
    await expect(loadStateSnapshot(filePath)).resolves.toEqual(snapshot)
    const stats = await fs.stat(filePath)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  it('rejects unsupported versions and quarantines malformed JSON instead of restoring it', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-state-invalid-'))
    const filePath = path.join(directory, 'runtime-state.json')
    await fs.writeFile(filePath, '{not-json', 'utf8')

    await expect(loadStateSnapshot(filePath)).resolves.toBeNull()
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' })
    const files = await fs.readdir(directory)
    expect(files.some((file) => file.startsWith('runtime-state.json.invalid-'))).toBe(true)
    expect(() => validateStateSnapshot({ version: 99, updatedAt: new Date().toISOString() })).toThrow('Unsupported state snapshot version')
  })
})
