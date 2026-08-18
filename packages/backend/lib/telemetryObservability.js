export async function getTelemetryHealth({ client, now = new Date(), p95LatencyTargetMs = 800, minSamples = 3 }) {
  const summary = await client.query(`
    SELECT
      COUNT(*)::integer AS total_events,
      COUNT(*) FILTER (WHERE received_at >= $1::timestamp - INTERVAL '24 hours')::integer AS events_last_24h,
      COALESCE(AVG(EXTRACT(EPOCH FROM (received_at - occurred_at)) * 1000), 0)::numeric(14, 2) AS average_ingestion_lag_ms,
      COALESCE(MAX(EXTRACT(EPOCH FROM (received_at - occurred_at)) * 1000), 0)::numeric(14, 2) AS max_ingestion_lag_ms,
      COUNT(*) FILTER (WHERE privacy_class = 'restricted')::integer AS restricted_events
    FROM production_telemetry_events
  `, [now.toISOString()])
  const coverage = await client.query(`
    SELECT event_type, COUNT(*)::integer AS count
    FROM production_telemetry_events
    GROUP BY event_type
    ORDER BY event_type
  `)
  const lagByType = await client.query(`
    SELECT
      event_type,
      COUNT(*)::integer AS count,
      COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (received_at - occurred_at)) * 1000), 0)::numeric(14, 2) AS median_lag_ms,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (received_at - occurred_at)) * 1000), 0)::numeric(14, 2) AS p95_lag_ms
    FROM production_telemetry_events
    GROUP BY event_type
    ORDER BY event_type
  `)
  const shadows = await client.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'shadow')::integer AS shadow_runs,
      COUNT(*) FILTER (WHERE reviewer_decision = 'pending')::integer AS pending_reviews,
      COUNT(*) FILTER (WHERE reviewer_decision = 'approved_pilot')::integer AS approved_pilot_runs
    FROM ai_evaluation_runs
  `)
  const row = summary.rows[0]
  const totalEvents = Number(row.total_events)
  const byEventType = Object.fromEntries(lagByType.rows.map((item) => [item.event_type, {
    count: Number(item.count),
    medianLagMs: Number(item.median_lag_ms),
    p95LagMs: Number(item.p95_lag_ms)
  }]))
  const p95LagMs = Object.values(byEventType).reduce((max, item) => Math.max(max, item.p95LagMs), 0)
  const sampleSufficient = totalEvents >= minSamples
  return {
    status: Number(row.restricted_events) > 0 ? 'attention' : 'ok',
    generatedAt: now.toISOString(),
    ingestion: {
      totalEvents,
      eventsLast24h: Number(row.events_last_24h),
      averageLagMs: Number(row.average_ingestion_lag_ms),
      maxLagMs: Number(row.max_ingestion_lag_ms),
      restrictedEvents: Number(row.restricted_events),
      byEventType
    },
    performance: {
      sampleCount: totalEvents,
      minSamples,
      sampleSufficient,
      p95LagMs,
      p95LatencyTargetMs,
      withinTarget: sampleSufficient ? p95LagMs <= p95LatencyTargetMs : null
    },
    coverage: Object.fromEntries(coverage.rows.map((item) => [item.event_type, Number(item.count)])),
    shadowEvaluation: {
      shadowRuns: Number(shadows.rows[0].shadow_runs),
      pendingReviews: Number(shadows.rows[0].pending_reviews),
      approvedPilotRuns: Number(shadows.rows[0].approved_pilot_runs)
    },
    safety: {
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }
  }
}
