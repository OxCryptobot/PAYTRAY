import { closeDatabase, initializeDatabase, transaction } from '../lib/database.js'
import { getTelemetryHealth } from '../lib/telemetryObservability.js'

try {
  await initializeDatabase()
  const report = await transaction(async (client) => {
    const telemetry = await client.query(`
      SELECT event_type, privacy_class, COUNT(*)::integer AS count
      FROM production_telemetry_events
      GROUP BY event_type, privacy_class
      ORDER BY event_type, privacy_class
    `)
    const outcomes = await client.query(`
      SELECT verification_status, COUNT(*)::integer AS count
      FROM engagement_outcome_events
      GROUP BY verification_status
      ORDER BY verification_status
    `)
    const runs = await client.query(`
      SELECT status, reviewer_decision, COUNT(*)::integer AS count
      FROM ai_evaluation_runs
      GROUP BY status, reviewer_decision
      ORDER BY status, reviewer_decision
    `)
    const decisions = await client.query('SELECT COUNT(*)::integer AS count FROM ai_shadow_decisions')
    const health = await getTelemetryHealth({ client })
    return { telemetry: telemetry.rows, outcomes: outcomes.rows, runs: runs.rows, shadowDecisions: Number(decisions.rows[0].count), health }
  })
  console.log(JSON.stringify({ status: 'ok', ...report }, null, 2))
} finally {
  await closeDatabase()
}
