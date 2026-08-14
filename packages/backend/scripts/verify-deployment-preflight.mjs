import config, { validateConfig } from '../lib/config.js'
import { buildDeploymentPreflight } from '../lib/deploymentPreflight.js'

const target = process.env.DEPLOYMENT_TARGET || 'railway-trial'
let configError = null
try {
  validateConfig()
} catch (error) {
  configError = error.message
}

const report = buildDeploymentPreflight({ config, deploymentTarget: target })
if (configError) {
  report.ready = false
  report.checks.push({ name: 'config', ready: false, reason: configError })
}

console.log(JSON.stringify(report, null, 2))
if (!report.ready) process.exitCode = 1
