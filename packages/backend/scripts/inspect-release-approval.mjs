import config from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { getReleaseReadiness } from '../lib/releaseReadiness.js'
import { getVerifierObservability } from '../lib/verifierObservability.js'
import { buildDurableReconciliationReport } from '../lib/payments/reconciliationService.js'
import { listShadowRuns } from '../lib/shadowReviewService.js'
import { buildDeploymentPreflight } from '../lib/deploymentPreflight.js'
import { buildReleaseApprovalArtifact } from '../lib/releaseApprovalGate.js'
import { parseTokenRegistry } from '../lib/payments/tokenRegistry.js'

let exitCode = 0
try {
  await initializeDatabase()
  const artifact = await transaction(async (client) => {
    const readiness = await getReleaseReadiness({
      client,
      config,
      databaseStatus: getDatabaseStatus(),
      enabledTokenCount: parseTokenRegistry(config.payments.tokenRegistry).list({ enabledOnly: true }).length,
      verifierWorkerStatus: config.payments.rpcUrl ? 'configured' : 'not_configured'
    })
    const verifier = await getVerifierObservability({ client, config })
    const reconciliation = await buildDurableReconciliationReport({ client, maxProjectionLagMs: config.payments.reconciliationLagThresholdMs })
    const shadowQueue = await listShadowRuns({ client, reviewerDecision: 'pending', limit: 100 })
    const rollbackResult = await client.query("SELECT COUNT(*)::int AS count FROM ai_evaluation_runs WHERE rollback_target IS NOT NULL")
    return buildReleaseApprovalArtifact({
      deploymentPreflight: buildDeploymentPreflight({ config, deploymentTarget: process.env.DEPLOYMENT_TARGET || 'unspecified' }),
      readiness,
      reconciliation,
      verifierStatus: verifier.verifierStatus,
      pendingShadowReviews: shadowQueue.count,
      rollbackTargets: rollbackResult.rows[0]?.count || 0,
      humanApproval: null
    })
  })
  exitCode = artifact.status === 'approved' ? 0 : 1
  console.log(JSON.stringify({ status: 'ok', artifact }, null, 2))
} finally {
  await closeDatabase()
}
process.exitCode = exitCode
