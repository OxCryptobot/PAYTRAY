import { getTelemetryHealth } from './telemetryObservability.js'
import { getVerifierReadiness } from './payments/verifierReadiness.js'

export async function getReleaseReadiness({ client, config, databaseStatus, enabledTokenCount, verifierWorkerStatus = 'not_configured', env = config.env }) {
  const telemetry = await getTelemetryHealth({ client, ...(config.observability || {}) })
  const verifier = await getVerifierReadiness({ client, config, verifierWorkerStatus, env })
  const outcomes = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE verification_status = 'verified')::integer AS verified_outcomes,
      COUNT(*) FILTER (WHERE verification_status = 'unverified')::integer AS unverified_outcomes,
      COUNT(*)::integer AS total_outcomes
    FROM engagement_outcome_events
  `)
  const outcomeRow = outcomes.rows[0]
  const verifiedOutcomes = Number(outcomeRow.verified_outcomes)
  const shadowRunsPending = telemetry.shadowEvaluation.pendingReviews
  const checks = {
    database: { ready: databaseStatus === 'ready', value: databaseStatus },
    protocol: { ready: Boolean(config.payments.protocolContractAddress), value: config.payments.protocolContractAddress ? 'configured' : 'unconfigured' },
    tokenRegistry: { ready: enabledTokenCount > 0, enabledTokenCount },
    verifierWorker: { ready: verifier.ready, value: verifier.status, cursor: verifier.cursor, cursorAgeMs: verifier.cursorAgeMs, maxCursorAgeMs: verifier.maxCursorAgeMs, reason: verifier.reason },
    telemetry: { ready: telemetry.status === 'ok', status: telemetry.status, eventsLast24h: telemetry.ingestion.eventsLast24h },
    verifiedOutcomeCoverage: { ready: verifiedOutcomes > 0, verifiedOutcomes, totalOutcomes: Number(outcomeRow.total_outcomes) },
    shadowReview: { ready: shadowRunsPending === 0, pendingReviews: shadowRunsPending },
    promotionAuthority: { ready: false, reason: 'AI outputs remain shadow-only until explicit human approval and rollback review' }
  }
  const shadowPilotReady = Object.entries(checks)
    .filter(([name]) => name !== 'promotionAuthority')
    .every(([, check]) => check.ready)
  return {
    status: shadowPilotReady ? 'shadow_pilot_ready' : 'not_ready',
    promotionStatus: 'shadow_only',
    generatedAt: new Date().toISOString(),
    checks,
    metrics: {
      verifiedOutcomes,
      unverifiedOutcomes: Number(outcomeRow.unverified_outcomes),
      telemetry,
      shadowRunsPending
    }
  }
}
