import { loadSecretManagerCustodyManifest, buildSecretManagerCustodyEvidence } from '../lib/secretManagerCustodyService.js'

try {
  const manifest = await loadSecretManagerCustodyManifest()
  const evidence = buildSecretManagerCustodyEvidence({ manifest })
  console.log(JSON.stringify(evidence, null, 2))
  process.exitCode = evidence.status === 'verified' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    secretMaterialIncluded: false,
    privateKeyMaterialIncluded: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'secret_manager_custody_evidence_only'
  }, null, 2))
  process.exitCode = 1
}
