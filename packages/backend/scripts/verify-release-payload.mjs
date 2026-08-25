import fs from 'fs/promises'
import { verifySignedReleasePayload } from '../lib/releasePayload.js'

async function readRegularNonSymlinkFile(filePath) {
  let stat
  try {
    stat = await fs.lstat(filePath)
  } catch {
    throw new Error('payload file is not a regular file')
  }
  if (stat.isSymbolicLink()) throw new Error('payload file must not be a symlink')
  if (!stat.isFile()) throw new Error('payload file must be a regular file')
  return fs.readFile(filePath, 'utf8')
}

const payloadPath = process.argv[2] || process.env.RELEASE_PAYLOAD_FILE
if (!payloadPath) {
  console.error(JSON.stringify({ status: 'blocked', reason: 'payload file path is required', mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }, null, 2))
  process.exitCode = 1
} else {
  try {
    const payload = JSON.parse(await readRegularNonSymlinkFile(payloadPath))
    const signatureValid = verifySignedReleasePayload(payload)
    const evidenceReady = payload?.status === 'ready' && payload?.evidence?.approval?.status === 'approved' && payload?.evidence?.manifest?.status === 'ready' && payload?.evidence?.railway?.status === 'matched' && payload?.evidence?.migration?.status === 'passed' && payload?.evidence?.recovery?.status === 'verified'
    const verified = signatureValid && evidenceReady
    console.log(JSON.stringify({ status: verified ? 'verified' : 'blocked', signatureValid, evidenceReady, algorithm: payload?.algorithm || null, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }, null, 2))
    process.exitCode = verified ? 0 : 1
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', reason: 'payload could not be parsed or read', error: error.message, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }, null, 2))
    process.exitCode = 1
  }
}
