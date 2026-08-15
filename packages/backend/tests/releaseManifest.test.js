import { describe, expect, it } from 'vitest'
import { buildReleaseManifest } from '../lib/releaseManifest.js'

const config = { env: 'development', payments: { settlementChainId: 84532, protocol: 'sablier-flow-v3', mainnetEnabled: false, rpcUrl: 'https://base-sepolia.example.invalid' } }
const artifacts = [{ path: 'packages/backend/server.js', sha256: 'a'.repeat(64), bytes: 10 }]

describe('release manifest', () => {
  it('produces a ready read-only manifest for a clean testnet release', () => {
    const manifest = buildReleaseManifest({ config, gitCommit: 'a'.repeat(40), dirty: false, artifacts })
    expect(manifest).toMatchObject({ status: 'ready', gitCommit: 'a'.repeat(40), dirty: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false, settlement: { chainId: 84532, mainnetEnabled: false } })
    expect(manifest.manifestHash).toHaveLength(64)
  })

  it('blocks dirty or incomplete release evidence', () => {
    const manifest = buildReleaseManifest({ config, gitCommit: null, dirty: true, artifacts: [] })
    expect(manifest.status).toBe('blocked')
    expect(manifest.checks.find((check) => check.name === 'gitCommit').ready).toBe(false)
    expect(manifest.checks.find((check) => check.name === 'cleanWorktree').ready).toBe(false)
    expect(manifest.checks.find((check) => check.name === 'artifactEvidence').ready).toBe(false)
  })
})
