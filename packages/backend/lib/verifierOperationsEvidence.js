import { getVerifierObservability } from './verifierObservability.js'
import { buildDurableReconciliationReport } from './payments/reconciliationService.js'

export async function buildVerifierOperationsEvidence({ client, config, now = new Date() }) {
  const [verifier, reconciliation, auditResult] = await Promise.all([
    getVerifierObservability({ client, config, now }),
    buildDurableReconciliationReport({ client, asOf: now, maxProjectionLagMs: config.payments.reconciliationLagThresholdMs }),
    client.query(`
      SELECT action, COUNT(*)::int AS count, MAX(created_at) AS latest_at
      FROM financial_audit_events
      WHERE actor_type IN ('verifier', 'ledger_worker')
      GROUP BY action
      ORDER BY action
    `)
  ])

  const auditActivity = auditResult.rows.map((row) => ({
    action: row.action,
    count: Number(row.count),
    latestAt: row.latest_at
  }))
  const unlinkedEvidence = Number(verifier.unlinkedEvidenceCount || 0)
  const ready = verifier.verifierStatus.ready && verifier.verifierStatus.status === 'fresh' && reconciliation.status === 'ok' && unlinkedEvidence === 0
  const reasons = []
  if (verifier.verifierStatus.status !== 'fresh') reasons.push(`verifier status is ${verifier.verifierStatus.status}`)
  if (reconciliation.status !== 'ok') reasons.push(`reconciliation status is ${reconciliation.status}`)
  if (unlinkedEvidence > 0) reasons.push(`${unlinkedEvidence} chain event(s) are unlinked to a stream or intent`)

  return {
    status: ready ? 'ready' : 'blocked',
    reason: ready ? 'fresh verifier, clean reconciliation, and linked chain evidence are present' : reasons.join('; '),
    verifier,
    reconciliation: {
      status: reconciliation.status,
      asOf: reconciliation.asOf,
      summary: reconciliation.summary,
      issues: reconciliation.issues
    },
    auditActivity,
    authority: 'verifier_operations_evidence',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}
