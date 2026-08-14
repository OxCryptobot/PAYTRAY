export async function buildDurableReconciliationReport({ client, asOf = new Date(), maxProjectionLagMs = 300000 }) {
  const streams = await client.query(`
    SELECT
      ps.id,
      ps.lifecycle_state,
      ps.finality_status,
      ps.protocol_stream_id,
      MAX(pce.transaction_hash) AS last_transaction_hash,
      COUNT(DISTINCT pce.id)::integer AS chain_event_count,
      COUNT(DISTINCT le.id)::integer AS ledger_entry_count,
      MAX(pce.observed_at) AS last_chain_event_at,
      MAX(pce.finalized_at) AS last_finalized_at,
      MAX(le.created_at) AS last_ledger_entry_at
    FROM payment_streams ps
    LEFT JOIN payment_chain_events pce ON pce.stream_id = ps.id
    LEFT JOIN ledger_entries le ON le.source_chain_event_id = pce.id
    GROUP BY ps.id
    ORDER BY ps.created_at DESC
  `)
  const intents = await client.query(`
    SELECT
      pi.id,
      pi.status,
      pi.transaction_hash,
      pi.stream_id,
      COUNT(pce.id)::integer AS matching_chain_events
    FROM payment_intents pi
    LEFT JOIN payment_chain_events pce ON pce.intent_id = pi.id
    GROUP BY pi.id
    ORDER BY pi.created_at DESC
  `)

  const issues = []
  const streamRows = streams.rows.map((row) => {
    const lifecycleConsistent = !(
      (row.finality_status === 'finalized' && !['chain_finalized'].includes(row.lifecycle_state)) ||
      (['reorged', 'invalid'].includes(row.finality_status) && row.lifecycle_state !== 'failed')
    )
    if (!lifecycleConsistent) issues.push({ type: 'lifecycle_finality_mismatch', streamId: row.id, lifecycleState: row.lifecycle_state, finalityStatus: row.finality_status })
    if (row.finality_status === 'finalized' && Number(row.ledger_entry_count) === 0) issues.push({ type: 'finalized_without_ledger_entry', streamId: row.id })
    const chainEvidenceAt = row.last_finalized_at || row.last_chain_event_at
    const projectionLagMs = chainEvidenceAt && row.last_ledger_entry_at
      ? Math.max(0, new Date(row.last_ledger_entry_at).getTime() - new Date(chainEvidenceAt).getTime())
      : null
    const projectionStatus = Number(row.ledger_entry_count) === 0 && row.finality_status === 'finalized'
      ? 'missing'
      : projectionLagMs != null && projectionLagMs > maxProjectionLagMs
        ? 'lagging'
        : 'fresh'
    if (projectionStatus === 'lagging') issues.push({ type: 'ledger_projection_lag', streamId: row.id, projectionLagMs, thresholdMs: maxProjectionLagMs })
    return {
      streamId: row.id,
      lifecycleState: row.lifecycle_state,
      finalityStatus: row.finality_status,
      chainEventCount: Number(row.chain_event_count),
      ledgerEntryCount: Number(row.ledger_entry_count),
      lifecycleConsistent,
      lastChainEventAt: row.last_chain_event_at,
      lastFinalizedAt: row.last_finalized_at,
      lastLedgerEntryAt: row.last_ledger_entry_at,
      projectionLagMs,
      projectionStatus
    }
  })
  const intentRows = intents.rows.map((row) => {
    const transactionEvidenceGap = Boolean(row.transaction_hash) && Number(row.matching_chain_events) === 0
    if (transactionEvidenceGap) issues.push({ type: 'intent_transaction_without_chain_event', intentId: row.id })
    return {
      intentId: row.id,
      status: row.status,
      streamId: row.stream_id,
      matchingChainEvents: Number(row.matching_chain_events),
      transactionEvidenceGap
    }
  })
  return {
    status: issues.length ? 'attention' : 'ok',
    asOf: asOf.toISOString(),
    authority: 'read_only_reconciliation_report',
    summary: {
      streams: streamRows.length,
      intents: intentRows.length,
      issues: issues.length,
      finalizedStreams: streamRows.filter((row) => row.finalityStatus === 'finalized').length,
      projectionLagThresholdMs: maxProjectionLagMs,
      laggingStreams: streamRows.filter((row) => row.projectionStatus === 'lagging').length,
      missingLedgerStreams: streamRows.filter((row) => row.projectionStatus === 'missing').length
    },
    issues,
    streams: streamRows,
    intents: intentRows
  }
}
