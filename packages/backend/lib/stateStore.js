import fs from 'fs/promises'
import path from 'path'

async function ensureDirectory(filePath) {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
}

export async function loadStateSnapshot(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function saveStateSnapshot(filePath, snapshot) {
  const contents = JSON.stringify(snapshot, null, 2)
  await ensureDirectory(filePath)
  const tempPath = `${filePath}.tmp`
  await fs.writeFile(tempPath, contents, 'utf8')
  await fs.rename(tempPath, filePath)
}

export class SnapshotWriter {
  constructor(capture, save) {
    this.capture = capture
    this.save = save
    this.revision = 0
    this.savedRevision = 0
    this.tail = Promise.resolve()
  }

  markDirty() {
    this.revision += 1
  }

  flush(force = false) {
    const operation = this.tail.catch(() => {}).then(async () => {
      if (!force && this.revision === this.savedRevision) return false
      const revision = this.revision
      const snapshot = this.capture()
      await this.save(snapshot)
      this.savedRevision = revision
      return true
    })
    this.tail = operation
    return operation
  }
}

export default {
  loadStateSnapshot,
  saveStateSnapshot
}
