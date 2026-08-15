const RAILWAY_SERVICE_STATUSES = new Set(['running', 'offline', 'deploying', 'failed', 'crashed', 'sleeping', 'unknown'])

function parseOptionalName(value, label) {
  if (value == null || value === '') return null
  const normalized = String(value).trim()
  if (!normalized) return null
  if (normalized.length > 128) throw new Error(`${label} must be 128 characters or fewer`)
  return normalized
}

function parseOptionalServiceStatus(value, label) {
  if (value == null || value === '') return null
  const normalized = String(value).trim().toLowerCase()
  if (!RAILWAY_SERVICE_STATUSES.has(normalized)) throw new Error(`${label} must be a recognized non-secret service status`)
  return normalized
}

function parseOptionalBoolean(value) {
  if (value == null || value === '') return null
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('Railway mainnet setting must be true or false')
}

export function validateRailwayTrialUrl(value) {
  if (value == null || value === '') return { configured: false, url: null, reason: 'RAILWAY_TRIAL_BASE_URL was not supplied' }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('RAILWAY_TRIAL_BASE_URL must be a valid URL')
  }
  if (parsed.protocol !== 'https:') throw new Error('RAILWAY_TRIAL_BASE_URL must use HTTPS')
  if (parsed.username || parsed.password) throw new Error('RAILWAY_TRIAL_BASE_URL must not contain credentials')
  return { configured: true, url: parsed.origin, reason: 'HTTPS Railway trial URL supplied' }
}

export function compareRailwayTrialSettings({ preflight, settings = {} }) {
  const checks = []
  const environment = settings.environment || null
  const settlementChainId = settings.settlementChainId == null ? null : Number(settings.settlementChainId)
  const mainnetEnabled = parseOptionalBoolean(settings.mainnetEnabled)
  checks.push({ name: 'environment', status: environment == null ? 'unavailable' : environment === preflight.environment ? 'match' : 'mismatch', expected: preflight.environment, observed: environment })
  checks.push({ name: 'settlementChainId', status: settlementChainId == null ? 'unavailable' : settlementChainId === preflight.settlement.chainId ? 'match' : 'mismatch', expected: preflight.settlement.chainId, observed: settlementChainId })
  checks.push({ name: 'paymentMainnetEnabled', status: mainnetEnabled == null ? 'unavailable' : mainnetEnabled === preflight.settlement.mainnetEnabled ? 'match' : 'mismatch', expected: preflight.settlement.mainnetEnabled, observed: mainnetEnabled })
  const mismatches = checks.filter((item) => item.status === 'mismatch')
  const unavailable = checks.filter((item) => item.status === 'unavailable')
  return {
    status: mismatches.length > 0 ? 'mismatch' : unavailable.length > 0 ? 'settings_unavailable' : 'match',
    checks,
    readOnly: true,
    deploymentPerformed: false
  }
}

export function parseRailwaySettingsFromEnv(env = process.env) {
  return {
    environment: env.RAILWAY_TRIAL_ENVIRONMENT || null,
    settlementChainId: env.RAILWAY_TRIAL_SETTLEMENT_CHAIN_ID || null,
    mainnetEnabled: env.RAILWAY_TRIAL_PAYMENT_MAINNET_ENABLED || null
  }
}

export function parseRailwayMetadataFromEnv(env = process.env) {
  const projectName = parseOptionalName(env.RAILWAY_PROJECT_NAME, 'RAILWAY_PROJECT_NAME')
  const environmentName = parseOptionalName(env.RAILWAY_ENVIRONMENT_NAME, 'RAILWAY_ENVIRONMENT_NAME')
  const services = {
    web: parseOptionalServiceStatus(env.RAILWAY_WEB_SERVICE_STATUS, 'RAILWAY_WEB_SERVICE_STATUS'),
    worker: parseOptionalServiceStatus(env.RAILWAY_WORKER_SERVICE_STATUS, 'RAILWAY_WORKER_SERVICE_STATUS')
  }
  const observed = Boolean(projectName && environmentName && services.web && services.worker)
  return {
    status: observed ? 'observed' : 'metadata_unavailable',
    source: observed ? 'operator_supplied_non_secret_metadata' : 'not_supplied',
    projectName,
    environmentName,
    services,
    readOnly: true,
    deploymentPerformed: false
  }
}
