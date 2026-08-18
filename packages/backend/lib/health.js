export function buildLivenessReport({ pid = process.pid, uptimeSeconds = process.uptime(), now = new Date() } = {}) {
  return {
    status: 'alive',
    live: true,
    authority: 'process_liveness_only',
    dependencyChecksPerformed: false,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    uptimeSeconds: Number.isFinite(Number(uptimeSeconds)) ? Math.max(0, Number(uptimeSeconds)) : null,
    timestamp: now.toISOString(),
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export function buildReadinessReport({ env, databaseStatus, protocol, protocolContractAddress, enabledTokenCount, verifierWorkerStatus = 'not_configured' }) {
  const checks = {
    database: {
      status: databaseStatus,
      ready: databaseStatus === 'ready' || (env !== 'production' && databaseStatus === 'unconfigured')
    },
    paymentProtocol: {
      status: protocolContractAddress ? 'configured' : 'unconfigured',
      protocol,
      ready: Boolean(protocolContractAddress)
    },
    tokenRegistry: {
      status: enabledTokenCount > 0 ? 'configured' : 'empty',
      enabledTokenCount,
      ready: enabledTokenCount > 0
    },
    verifierWorker: {
      status: verifierWorkerStatus,
      ready: verifierWorkerStatus === 'ready' || (env !== 'production' && verifierWorkerStatus === 'not_configured')
    }
  }

  const ready = Object.values(checks).every((check) => check.ready)
  return {
    status: ready ? 'ready' : 'degraded',
    ready,
    checks
  }
}
