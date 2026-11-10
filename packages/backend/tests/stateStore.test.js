import { describe, expect, it, vi } from 'vitest'
import { SnapshotWriter } from '../lib/stateStore.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('SnapshotWriter', () => {
  it('serializes overlapping flushes and preserves mutations during a write', async () => {
    const firstWrite = deferred()
    let value = 1
    const snapshots = []
    const save = vi.fn(async (snapshot) => {
      snapshots.push(snapshot.value)
      if (snapshots.length === 1) await firstWrite.promise
    })
    const writer = new SnapshotWriter(() => ({ value }), save)
    writer.markDirty()
    const first = writer.flush()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    value = 2
    writer.markDirty()
    const second = writer.flush()
    expect(save).toHaveBeenCalledTimes(1)
    firstWrite.resolve()
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
    expect(snapshots).toEqual([1, 2])
    await expect(writer.flush()).resolves.toBe(false)
  })

  it('keeps state dirty after a failed write and retries successfully', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk failure')).mockResolvedValueOnce()
    const writer = new SnapshotWriter(() => ({ value: 1 }), save)
    writer.markDirty()
    await expect(writer.flush()).rejects.toThrow('disk failure')
    await expect(writer.flush()).resolves.toBe(true)
    expect(save).toHaveBeenCalledTimes(2)
    await expect(writer.flush()).resolves.toBe(false)
  })

  it('writes when forced even if no state is dirty', async () => {
    const save = vi.fn().mockResolvedValue()
    const writer = new SnapshotWriter(() => ({ value: 1 }), save)
    await expect(writer.flush(true)).resolves.toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
