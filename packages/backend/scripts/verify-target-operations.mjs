import config, { validateConfig } from '../lib/config.js'
import { buildTargetOperationsPreflight } from '../lib/targetOperationsPreflight.js'

try {
  validateConfig()
  const report = {
    reportKind: 'target_operations_evidence',
    ...buildTargetOperationsPreflight({ config }),
    ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
  }
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.status === 'ready' ? 0 : 1
} catch (error) {
      console.error(JSON.stringify({
    reportKind: 'target_operations_evidence',
    status: 'blocked',

    releaseEligible: false,
    reason: error.message,
    authority: 'configuration_preflight_only',
    mutation: 'read_only',
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
  }, null, 2))
  process.exitCode = 1
}
