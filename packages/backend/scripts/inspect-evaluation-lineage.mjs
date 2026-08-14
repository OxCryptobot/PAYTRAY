import { closeDatabase, initializeDatabase, transaction } from '../lib/database.js'

try {
  await initializeDatabase()
  const rows = await transaction(async (client) => {
    const result = await client.query(`
      SELECT di.query_id, di.candidate_profile_id, di.engagement_id, di.selected,
             di.observed_at, o.id AS outcome_id, o.event_type, o.verification_status
      FROM discovery_impressions di
      LEFT JOIN engagement_outcome_events o ON o.engagement_id = di.engagement_id
      ORDER BY di.observed_at DESC
      LIMIT 20
    `)
    return result.rows
  })
  console.log(JSON.stringify({ status: 'ok', rows }, null, 2))
} finally {
  await closeDatabase()
}
