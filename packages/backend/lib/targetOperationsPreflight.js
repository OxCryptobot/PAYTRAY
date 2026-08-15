import { buildDeploymentPreflight } from './deploymentPreflight.js'
import { compareRailwayTrialSettings, parseRailwaySettingsFromEnv, validateRailwayTrialUrl } from './railwayTrialGate.js'

function check(name, ready, reason, evidence = null) {
  return { name, ready, reason, ...(evidence == null ? {} : { evidence }) }
}

export function buildTargetOperationsPreflight({ config, env = process.env } = {}) {
  if (!config) throw new Error('config is required')
  const deploymentTarget = env.DEPLOYMENT_TARGET || 'railway-trial'
  const deployment = buildDeploymentPreflight({ config, deploymentTarget })
  const trialUrl = validateRailwayTrialUrl(env.RAILWAY_TRIAL_BASE_URL)
  const settingsComparison = compareRailwayTrialSettings({
    preflight: deployment,
    settings: parseRailwaySettingsFromEnv(env)
  })
  const databaseConfigured = Boolean(config.database?.url)
  const rpcConfigured = /^https:\/\//i.test(config.payments?.rpcUrl || '')
  const verifierWorkerReady = Boolean(config.verifierWorker?.enabled && databaseConfigured && rpcConfigured && config.payments?.settlementChainId === 84532 && config.payments?.mainnetEnabled === false && config.payments?.protocolContractAddress)
  const workerReady = Boolean(config.outboxWorker?.enabled && databaseConfigured && config.webhooks?.signingSecret)
  const housekeepingReady = Boolean(config.housekeeping?.idempotencyCleanupEnabled && databaseConfigured)
  const baseSepoliaSafe = config.payments?.settlementChainId === 84532 && config.payments?.mainnetEnabled === false
  const checks = [
    check('deploymentConfiguration', deployment.ready, deployment.ready ? 'deployment configuration is internally consistent' : 'deployment configuration has blocking errors'),
    check('railwayTrialUrl', trialUrl.configured, trialUrl.reason),
    check('railwaySettings', settingsComparison.status === 'match', settingsComparison.status === 'match' ? 'redacted Railway settings match local target policy' : `Railway settings evidence is ${settingsComparison.status}`),
    check('database', databaseConfigured, databaseConfigured ? 'DATABASE_URL is configured' : 'DATABASE_URL is unavailable'),
    check('paymentRpc', rpcConfigured, rpcConfigured ? 'HTTPS payment RPC is configured' : 'HTTPS payment RPC is unavailable'),
    check('baseSepoliaPolicy', baseSepoliaSafe, baseSepoliaSafe ? 'Base Sepolia is selected and mainnet is disabled' : 'target must use Base Sepolia with PAYMENT_MAINNET_ENABLED=false'),
    check('verifierWorker', verifierWorkerReady, verifierWorkerReady ? 'Base Sepolia verifier worker is explicitly enabled with HTTPS RPC and database' : 'verifier worker requires VERIFIER_WORKER_ENABLED=true, DATABASE_URL, HTTPS PAYMENT_RPC_URL, protocol contract, and Base Sepolia'),
    check('outboxWorker', workerReady, workerReady ? 'durable outbox worker is explicitly enabled with database and signing secret' : 'durable outbox worker requires OUTBOX_WORKER_ENABLED=true, DATABASE_URL, and WEBHOOK_SIGNING_SECRET'),
    check('idempotencyHousekeeping', housekeepingReady, housekeepingReady ? 'idempotency cleanup is explicitly enabled with database' : 'idempotency cleanup requires IDEMPOTENCY_CLEANUP_ENABLED=true and DATABASE_URL')
  ]
  const blockers = checks.filter((item) => !item.ready).map((item) => ({ name: item.name, reason: item.reason }))
  return {
    status: blockers.length === 0 ? 'ready' : 'blocked',
    releaseEligible: false,
    deploymentTarget,
    deployment,
    trialUrl,
    railwaySettings: settingsComparison,
    checks,
    blockers,
    verifierEvidence: {
      status: env.TARGET_VERIFIER_STATUS || 'not_provided',
      targetEvidenceRequired: true,
      acceptedStatus: 'fresh',
      note: 'Configuration cannot substitute for a durable verifier cursor and chain-event audit evidence.'
    },
    recoveryEvidence: {
      status: env.TARGET_RECOVERY_STATUS || 'not_provided',
      targetEvidenceRequired: true,
      acceptedStatus: 'verified',
      note: 'Configuration cannot substitute for an isolated target backup restore and catalog verification.'
    },
    authority: 'configuration_preflight_only',
    mutation: 'read_only',
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}
