import fs from 'node:fs/promises'
import { verifyOperatorEvidenceBundle } from '../lib/operatorEvidenceBundleService.js'

async function readRegularNonSymlinkFile(filePath) {
  let stat
  try {
    stat = await fs.lstat(filePath)
  } catch (error) {
    throw new Error(`bundle file cannot be inspected: ${error.message}`, { cause: error })
  }
  if (stat.isSymbolicLink()) throw new Error('bundle file must not be a symlink')
  if (!stat.isFile()) throw new Error('bundle file must be a regular file')
  return fs.readFile(filePath, 'utf8')
}

const filePath = process.argv[2]
let result
try {
  if (!filePath) throw new Error('bundle JSON path is required')
  const raw = await readRegularNonSymlinkFile(filePath)
  const bundle = JSON.parse(raw)
  result = verifyOperatorEvidenceBundle(bundle)
} catch (error) {
  result = {
    status: 'blocked',
    verified: false,
    reason: error.message,
    authority: 'operator_evidence_bundle_verifier_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}
console.log(JSON.stringify(result, null, 2))
process.exitCode = result.status === 'verified' ? 0 : 1
