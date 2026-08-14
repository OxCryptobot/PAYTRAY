export async function getFinancialSummary({ client, config }) {
  const [intentsResult, streamsResult, eventsResult, ledgerResult, unreconciledResult] = await Promise.all([
    client.query(`SELECT status, COUNT(*)::int AS count FROM payment_intents WHERE chain_id = $1 GROUP BY status ORDER BY status`, [config.payments.settlementChainId]),
    client.query(`SELECT lifecycle_state, COUNT(*)::int AS count FROM payment_streams GROUP BY lifecycle_state ORDER BY lifecycle_state`),
    client.query(`SELECT finality_status, COUNT(*)::int AS count FROM payment_chain_events WHERE chain_id = $1 GROUP BY finality_status ORDER BY finality_status`, [config.payments.settlementChainId]),
    client.query(`SELECT COUNT(*)::int AS count FROM ledger_entries WHERE chain_id = $1`, [config.payments.settlementChainId]),
    client.query(
      `SELECT COUNT(*)::int AS count
       FROM payment_streams stream
       WHERE NOT EXISTS (
         SELECT 1 FROM payment_chain_events event
         WHERE event.stream_id = stream.id
           AND event.chain_id = $1
           AND event.finality_status = 'finalized'
       )`,
      [config.payments.settlementChainId]
    )
  ])
  return {
    chainId: config.payments.settlementChainId,
    paymentIntentsByStatus: Object.fromEntries(intentsResult.rows.map((row) => [row.status, row.count])),
    durableStreamsByLifecycle: Object.fromEntries(streamsResult.rows.map((row) => [row.lifecycle_state, row.count])),
    chainEventsByFinality: Object.fromEntries(eventsResult.rows.map((row) => [row.finality_status, row.count])),
    ledgerEntryCount: ledgerResult.rows[0]?.count || 0,
    unreconciledStreamCount: unreconciledResult.rows[0]?.count || 0,
    authority: 'verifier_owned',
    mutation: 'read_only'
  }
}

export async function getVerifierObservability({ client, config, now = new Date() }) {
  const cursorResult = await client.query(
    `SELECT chain_id, last_scanned_block, updated_at
     FROM payment_verifier_cursors
     WHERE chain_id = $1`,
    [config.payments.settlementChainId]
  )
  const evidenceResult = await client.query(
    `SELECT finality_status, COUNT(*)::int AS count,
            MAX(observed_at) AS latest_observed_at,
            MAX(finalized_at) AS latest_finalized_at
     FROM payment_chain_events
     WHERE chain_id = $1
     GROUP BY finality_status`,
    [config.payments.settlementChainId]
  )
  const unlinkedResult = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM payment_chain_events
     WHERE chain_id = $1 AND stream_id IS NULL AND intent_id IS NULL`,
    [config.payments.settlementChainId]
  )
  const cursor = cursorResult.rows[0] || null
  const cursorAgeMs = cursor ? Math.max(0, now.getTime() - new Date(cursor.updated_at).getTime()) : null
  const finality = Object.fromEntries(evidenceResult.rows.map((row) => [row.finality_status, {
    count: row.count,
    latestObservedAt: row.latest_observed_at,
    latestFinalizedAt: row.latest_finalized_at
  }]))
  return {
    chainId: config.payments.settlementChainId,
    protocol: config.payments.protocol,
    contractAddress: config.payments.protocolContractAddress,
    configured: Boolean(config.payments.rpcUrl),
    finalityConfirmations: config.payments.finalityConfirmations,
    cursor,
    cursorAgeMs,
    finality,
    unlinkedEvidenceCount: unlinkedResult.rows[0]?.count || 0,
    authority: 'verifier_owned',
    mutation: 'read_only'
  }
}
