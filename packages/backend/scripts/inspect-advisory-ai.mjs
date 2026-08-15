import config from '../lib/config.js'
import { getAdvisoryAiCapabilities } from '../lib/advisoryAiBoundary.js'

const capabilities = getAdvisoryAiCapabilities({ config })
const ready = capabilities.enabled && capabilities.providerConfigured && capabilities.rawContentPersistence === false
console.log(JSON.stringify({
  status: ready ? 'ready' : 'blocked',
  reason: ready ? 'bounded advisory-AI provider is configured' : 'advisory-AI provider is disabled or incomplete',
  capabilities,
  authority: 'advisory_ai_only',
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false
}, null, 2))
process.exitCode = ready ? 0 : 1
