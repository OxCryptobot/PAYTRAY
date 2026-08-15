import config from '../lib/config.js'
import { buildDeploymentPreflight } from '../lib/deploymentPreflight.js'
import { compareRailwayTrialSettings, parseRailwayMetadataFromEnv, parseRailwaySettingsFromEnv, validateRailwayTrialUrl } from '../lib/railwayTrialGate.js'

const deploymentTarget = process.env.DEPLOYMENT_TARGET || 'railway-trial'
const preflight = buildDeploymentPreflight({ config, deploymentTarget })
const trialUrl = validateRailwayTrialUrl(process.env.RAILWAY_TRIAL_BASE_URL)
const settings = parseRailwaySettingsFromEnv()
const metadata = parseRailwayMetadataFromEnv()
const comparison = compareRailwayTrialSettings({ preflight, settings })
const status = !preflight.ready
  ? 'blocked'
  : comparison.status !== 'match'
    ? comparison.status
    : trialUrl.configured === false || metadata.status !== 'observed'
      ? 'metadata_unavailable'
      : 'match'
const report = {
  status,
  preflight,
  trialUrl,
  settingsComparison: comparison,
  railwayMetadata: metadata,
  deploymentPerformed: false,
  networkCallPerformed: false,
  mutation: 'read_only',
  releaseEligible: false,
  settlementAuthority: false
}
console.log(JSON.stringify(report, null, 2))
if (status !== 'match') process.exitCode = 1
