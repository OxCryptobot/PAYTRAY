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
  await ensureDirectory(filePath)
  const tempPath = `${filePath}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), 'utf8')
  await fs.rename(tempPath, filePath)
}

export default {
  loadStateSnapshot,
  saveStateSnapshot
}
