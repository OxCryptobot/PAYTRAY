import crypto from 'crypto'

export async function recordDiscoveryImpressions({ client, walletAddress, queryId = crypto.randomUUID(), queryFeatures = {}, experts }) {
  const user = await client.query('SELECT id FROM users WHERE wallet_address = $1', [String(walletAddress).toLowerCase()])
  if (!user.rows[0]) return { queryId, recorded: 0 }

  for (const [index, expert] of experts.entries()) {
    await client.query(
      `INSERT INTO discovery_impressions (
        query_id, client_id, candidate_profile_id, rank_position,
        baseline_score, ranking_version, query_features, match_explanation, provenance
      ) VALUES ($1, $2, $3, $4, $5, 'weighted-explainable-v1', $6::jsonb, $7::jsonb, $8::jsonb)
      ON CONFLICT (query_id, candidate_profile_id) DO UPDATE
      SET rank_position = EXCLUDED.rank_position,
          baseline_score = EXCLUDED.baseline_score,
          match_explanation = EXCLUDED.match_explanation`,
      [
        queryId,
        user.rows[0].id,
        expert.id,
        index + 1,
        Number(expert.matchScore || 0),
        JSON.stringify(queryFeatures),
        JSON.stringify(expert.matchExplanation || {}),
        JSON.stringify({ source: 'discovery_v2', rankingVersion: 'weighted-explainable-v1' })
      ]
    )
  }
  return { queryId, recorded: experts.length }
}
