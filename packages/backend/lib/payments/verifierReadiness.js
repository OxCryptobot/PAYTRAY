export async function getVerifierReadiness({ client, config, verifierWorkerStatus = 'not_configured', env = config.env, now = new Date() }) {
  const configured = verifierWorkerStatus === 'ready' || verifierWorkerStatus === 'configured'
  if (!configured) {
    return {
      ready: env !== 'production',
      status: 'not_configured',
      cursor: null,
      cursorAgeMs: null,
      maxCursorAgeMs: config.payments.verifierCursorMaxAgeMs,
      reason: env === 'production' ? 'RPC-backed verifier worker is not configured' : 'non-production environment permits an unconfigured verifier'
    }
  }

  const result = await client.query(
    `SELECT chain_id, last_scanned_block, updated_at
     FROM payment_verifier_cursors
     WHERE chain_id = $1`,
    [config.payments.settlementChainId]
  )
  const row = result.rows[0] || null
  const cursorAgeMs = row ? Math.max(0, now.getTime() - new Date(row.updated_at).getTime()) : null
  const fresh = row != null && cursorAgeMs <= config.payments.verifierCursorMaxAgeMs
  return {
    ready: fresh,
    status: fresh ? 'fresh' : row ? 'stale' : 'missing',
    cursor: row,
    cursorAgeMs,
    maxCursorAgeMs: config.payments.verifierCursorMaxAgeMs,
    reason: fresh ? 'durable verifier cursor is fresh' : row ? 'durable verifier cursor is stale' : 'durable verifier cursor is missing'
  }
}
