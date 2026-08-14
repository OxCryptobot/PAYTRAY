import { parseTokenRegistry } from './payments/tokenRegistry.js'

function check(name, ready, reason) {
  return { name, ready, reason }
}

export function buildDeploymentPreflight({ config, deploymentTarget = 'unspecified' }) {
  const production = config.env === 'production'
  const checks = [
    check('database', !production || Boolean(config.database.url), production ? 'DATABASE_URL configured' : 'development database requirement deferred'),
    check('jwt', !production || Boolean(config.jwt.secret), production ? 'JWT secret configured' : 'development JWT fallback permitted'),
    check('rpc', !production || /^https:\/\//i.test(config.payments.rpcUrl || ''), production ? 'HTTPS payment RPC configured' : 'development RPC requirement deferred'),
    check('protocol', !production || Boolean(config.payments.protocolContractAddress), production ? 'payment protocol contract configured' : 'development protocol requirement deferred'),
    check('webhookSigning', !production || Boolean(config.webhooks.signingSecret), production ? 'webhook signing secret configured' : 'development webhook signing requirement deferred'),
    check('verifierCursorAge', Number.isInteger(config.payments.verifierCursorMaxAgeMs) && config.payments.verifierCursorMaxAgeMs >= 1000, 'verifier cursor freshness threshold is bounded')
  ]

  let enabledTokenCount = 0
  let tokenRegistryError = null
  try {
    enabledTokenCount = parseTokenRegistry(config.payments.tokenRegistry).list({ chainId: config.payments.settlementChainId, enabledOnly: true }).length
  } catch (error) {
    tokenRegistryError = error.message
  }
  checks.push(check('tokenRegistry', !production || (!tokenRegistryError && enabledTokenCount > 0), tokenRegistryError || `${enabledTokenCount} enabled token(s) for settlement chain`))
  checks.push(check('mainnetGate', !production || config.payments.settlementChainId !== 8453 || config.payments.mainnetEnabled, 'Base mainnet requires PAYMENT_MAINNET_ENABLED=true'))

  return {
    ready: checks.every((item) => item.ready),
    environment: config.env,
    deploymentTarget,
    settlement: {
      chainId: config.payments.settlementChainId,
      protocol: config.payments.protocol,
      mainnetEnabled: config.payments.mainnetEnabled
    },
    checks,
    authority: 'configuration_preflight_only',
    mutation: 'read_only',
    deploymentPerformed: false
  }
}
