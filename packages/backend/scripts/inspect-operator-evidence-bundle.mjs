import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { collectReconciliationEvidence, collectReleaseEvidence } from '../lib/releaseEvidenceService.js'
import { listOperationsQualityRuns } from '../lib/operationsQualityAuditService.js'
import { buildOperatorEvidenceBundle } from '../lib/operatorEvidenceBundleService.js'
import config from '../lib/config.js'

let exitCode = 1
try {
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('operator evidence bundle requires a ready PostgreSQL database')
  const bundle = await transaction(async (client) => {
    const releaseEvidence = await collectReleaseEvidence({ client, config })
    const reconciliationEvidence = await collectReconciliationEvidence({ client, config })
    const operationsQualityRuns = await listOperationsQualityRuns({ client, limit: 20 })
    return buildOperatorEvidenceBundle({ releaseEvidence, reconciliationEvidence, operationsQualityRuns })
  })
  console.log(JSON.stringify(bundle, null, 2))
  exitCode = bundle.status === 'complete_pending_release_gate' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    authority: 'operator_evidence_bundle_export_only',
    paymentStateAuthority: 'verifier_and_ledger_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
} finally {
  await closeDatabase().catch(() => {})
}
process.exitCode = exitCode
