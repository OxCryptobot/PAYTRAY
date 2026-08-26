import config from '../lib/config.js'
import { getAdvisoryAiCapabilities, isAdvisoryAiCapabilityReady } from '../lib/advisoryAiBoundary.js'

const capabilities = getAdvisoryAiCapabilities({ config })
const ready = isAdvisoryAiCapabilityReady(capabilities)
console.log(JSON.stringify({
  reportKind: 'advisory_ai_evidence',
  status: ready ? 'ready' : 'blocked',
  reason: ready ? 'bounded advisory-AI provider is configured' : 'advisory-AI provider is disabled or incomplete',
  capabilities,
  authority: 'advisory_ai_only',
  promotionStatus: 'shadow_only',
  humanOverrideRequired: true,
  rawContentPersisted: false,
  applied: false,
  mutation: 'read_only',
  releaseEligible: false,
  settlementAuthority: false,
  deploymentPerformed: false,
  settlementMutationPerformed: false,
  ...(process.env.RELEASE_COMMIT ? { releaseCommit: process.env.RELEASE_COMMIT } : {})
}, null, 2))
process.exitCode = ready ? 0 : 1
