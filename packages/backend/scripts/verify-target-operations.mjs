import config, { validateConfig } from '../lib/config.js'
import { buildTargetOperationsPreflight } from '../lib/targetOperationsPreflight.js'

try {
  validateConfig()
  const report = buildTargetOperationsPreflight({ config })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.status === 'ready' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    releaseEligible: false,
    reason: error.message,
    authority: 'configuration_preflight_only',
    mutation: 'read_only',
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
