import crypto from 'crypto'
import fs from 'fs/promises'
import { execFileSync } from 'child_process'
import config from '../lib/config.js'
import { buildReleaseManifest } from '../lib/releaseManifest.js'

const artifactPaths = [
  'packages/backend/server.js',
  'packages/backend/lib/payments/sablierFlowV3.js',
  'packages/backend/lib/payments/verifiedEventService.js',
  'packages/backend/lib/releaseApprovalGate.js',
  'packages/client/app.js'
]

async function hashFile(path) {
  const content = await fs.readFile(path)
  return { path, sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length }
}

let exitCode = 0
try {
  const artifacts = await Promise.all(artifactPaths.map(hashFile))
  let gitCommit = null
  let dirty = true
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
  } catch {
    dirty = true
  }
  const manifest = buildReleaseManifest({ config, gitCommit, dirty, artifacts })
  exitCode = manifest.status === 'ready' ? 0 : 1
  console.log(JSON.stringify({ status: 'ok', manifest }, null, 2))
} finally {
  process.exitCode = exitCode
}
