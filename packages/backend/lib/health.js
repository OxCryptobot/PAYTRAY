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
