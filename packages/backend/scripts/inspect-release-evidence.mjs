import config from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { buildTargetOperationsPreflight } from '../lib/targetOperationsPreflight.js'
import { collectReleaseEvidence } from '../lib/releaseEvidenceService.js'

let exitCode
try {
  const targetOperations = buildTargetOperationsPreflight({ config })
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('release evidence requires a ready PostgreSQL database')
  const bundle = await transaction((client) => collectReleaseEvidence({
    client,
    config,
    targetOperations,
    signingKeyEvidence: {
      present: Boolean(process.env.RELEASE_SIGNING_KEY_PEM),
      publicKeyFingerprintSha256: process.env.RELEASE_SIGNING_PUBLIC_KEY_SHA256 || null,
      independentlyVerified: process.env.RELEASE_SIGNING_PUBLIC_KEY_FINGERPRINT_VERIFIED === 'true'
    }
  }))
  console.log(JSON.stringify({ reportKind: 'release_evidence', status: 'ok', bundle }, null, 2))
  exitCode = bundle.evidenceComplete ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    reportKind: 'release_evidence',
    status: 'blocked',
    reason: error.message,
    authority: 'release_evidence_aggregation_only',
    mutation: 'read_only',
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  exitCode = 1
} finally {
  await closeDatabase().catch(() => {})
}
process.exitCode = exitCode
