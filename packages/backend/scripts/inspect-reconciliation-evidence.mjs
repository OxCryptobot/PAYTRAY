import { execFileSync } from 'node:child_process'
import config from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { buildDurableReconciliationReport } from '../lib/payments/reconciliationService.js'
import { buildReconciliationEvidence } from '../lib/reconciliationEvidenceService.js'

let exitCode = 1
try {
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('reconciliation evidence requires a ready PostgreSQL database')
  const gitCommit = (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() } catch { return null }
  })()
  const evidence = await transaction(async (client) => {
    const report = await buildDurableReconciliationReport({
      client,
      maxProjectionLagMs: config.payments.reconciliationLagThresholdMs
    })
    return buildReconciliationEvidence({ report, gitCommit })
  })
  console.log(JSON.stringify({ status: 'ok', evidence }, null, 2))
  exitCode = evidence.status === 'verified' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    authority: 'read_only_reconciliation_report',
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  exitCode = 1
} finally {
  await closeDatabase().catch(() => {})
}
process.exitCode = exitCode
