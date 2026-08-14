import config from '../lib/config.js'
import { buildDeploymentPreflight } from '../lib/deploymentPreflight.js'
import { compareRailwayTrialSettings, parseRailwaySettingsFromEnv, validateRailwayTrialUrl } from '../lib/railwayTrialGate.js'

const deploymentTarget = process.env.DEPLOYMENT_TARGET || 'railway-trial'
const preflight = buildDeploymentPreflight({ config, deploymentTarget })
const trialUrl = validateRailwayTrialUrl(process.env.RAILWAY_TRIAL_BASE_URL)
const settings = parseRailwaySettingsFromEnv()
const comparison = compareRailwayTrialSettings({ preflight, settings })
const report = { preflight, trialUrl, settingsComparison: comparison, deploymentPerformed: false, networkCallPerformed: false }
console.log(JSON.stringify(report, null, 2))
if (!preflight.ready || comparison.status === 'mismatch' || trialUrl.configured === false) process.exitCode = 1
