import fs from 'node:fs/promises'
import { verifyOperatorEvidenceBundle } from '../lib/operatorEvidenceBundleService.js'

const filePath = process.argv[2]
let result
try {
  if (!filePath) throw new Error('bundle JSON path is required')
  const raw = await fs.readFile(filePath, 'utf8')
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
