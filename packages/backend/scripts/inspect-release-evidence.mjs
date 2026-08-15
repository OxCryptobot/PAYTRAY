import { readFile } from 'node:fs/promises'
import config from '../lib/config.js'
import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { parseTokenRegistry } from '../lib/payments/tokenRegistry.js'
import { buildTargetOperationsPreflight } from '../lib/targetOperationsPreflight.js'
import { getReleaseReadiness } from '../lib/releaseReadiness.js'
import { buildVerifierOperationsEvidence } from '../lib/verifierOperationsEvidence.js'
import { getOutboxHealth } from '../lib/outboxDeliveryService.js'
import { getWebhookInboxHealth } from '../lib/webhookInboxService.js'
import { listShadowRuns } from '../lib/shadowReviewService.js'
import { buildReleaseEvidenceBundle } from '../lib/releaseEvidenceService.js'

async function loadSignoffs() {
  const path = process.env.RELEASE_SIGNOFFS_FILE
  if (!path) return []
  const value = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(value)) throw new Error('RELEASE_SIGNOFFS_FILE must contain a JSON array')
  return value
}

let exitCode = 1
try {
  const targetOperations = buildTargetOperationsPreflight({ config })
  const signoffs = await loadSignoffs()
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('release evidence requires a ready PostgreSQL database')
  const bundle = await transaction(async (client) => {
    const tokenRegistry = parseTokenRegistry(config.payments.tokenRegistry)
    const verifierOperations = await buildVerifierOperationsEvidence({ client, config })
    const readiness = await getReleaseReadiness({
      client,
      config,
      databaseStatus: getDatabaseStatus(),
      enabledTokenCount: tokenRegistry.list({ chainId: config.payments.settlementChainId, enabledOnly: true }).length,
      verifierWorkerStatus: config.verifierWorker?.enabled ? 'configured' : 'not_configured'
    })
    const outboxHealth = await getOutboxHealth({ client, maxAttempts: config.webhooks.maxAttempts })
    const webhookInboxHealth = await getWebhookInboxHealth({ client })
    const shadowQueue = await listShadowRuns({ client, reviewerDecision: 'pending', limit: 100 })
    const rollbackResult = await client.query('SELECT COUNT(*)::int AS count FROM ai_evaluation_runs WHERE rollback_target IS NOT NULL')
    return buildReleaseEvidenceBundle({
      targetOperations,
      deploymentPreflight: targetOperations.deployment,
      readiness,
      verifierOperations,
      reconciliation: verifierOperations.reconciliation,
      outboxHealth,
      webhookInboxHealth,
      pendingShadowReviews: shadowQueue.count,
      rollbackTargets: rollbackResult.rows[0]?.count || 0,
      signoffs,
      signingKeyEvidencePresent: Boolean(process.env.RELEASE_SIGNING_KEY_PEM)
    })
  })
  console.log(JSON.stringify({ status: 'ok', bundle }, null, 2))
  exitCode = bundle.evidenceComplete ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
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
