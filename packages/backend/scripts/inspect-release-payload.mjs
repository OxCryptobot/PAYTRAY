import fs from 'fs/promises'
import crypto from 'crypto'
import config from '../lib/config.js'
import { buildReleaseManifest } from '../lib/releaseManifest.js'
import { buildSignedReleasePayload } from '../lib/releasePayload.js'

const manifestArtifacts = [
  'packages/backend/server.js',
  'packages/backend/lib/payments/sablierFlowV3.js',
  'packages/backend/lib/payments/verifiedEventService.js',
  'packages/backend/lib/releaseApprovalGate.js',
  'packages/client/app.js'
]

async function artifactEvidence() {
  return Promise.all(manifestArtifacts.map(async (path) => {
    const content = await fs.readFile(path)
    return { path, sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length }
  }))
}

const manifest = buildReleaseManifest({
  config,
  gitCommit: process.env.RELEASE_GIT_COMMIT || null,
  dirty: process.env.RELEASE_DIRTY === 'true',
  artifacts: await artifactEvidence()
})
const approval = { status: process.env.RELEASE_APPROVAL_STATUS || 'blocked', eligible: process.env.RELEASE_APPROVAL_ELIGIBLE === 'true' }
const railway = { status: process.env.RAILWAY_SETTINGS_STATUS || 'unavailable' }
const migration = { status: process.env.MIGRATION_EVIDENCE_STATUS || 'unverified' }
const recovery = { status: process.env.RECOVERY_EVIDENCE_STATUS || 'unverified' }
const signer = process.env.RELEASE_SIGNING_KEY_PEM ? { privateKeyPem: process.env.RELEASE_SIGNING_KEY_PEM } : null
const payload = buildSignedReleasePayload({ manifest, approval, railway, migration, recovery, signer })
console.log(JSON.stringify({ status: 'ok', payload }, null, 2))
process.exitCode = payload.status === 'ready' ? 0 : 1
