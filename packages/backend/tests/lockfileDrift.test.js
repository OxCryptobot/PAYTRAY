import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateLockfileDrift } from '../scripts/verify-lockfile-drift.mjs'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

async function writeFixture({ backendDependency = '^1.0.0' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-lockfile-drift-'))
  await fs.mkdir(path.join(root, 'packages/backend'), { recursive: true })
  await fs.mkdir(path.join(root, 'packages/sdk'), { recursive: true })
  const rootManifest = {
    name: 'paytray',
    version: '0.1.0',
    workspaces: { packages: ['packages/backend', 'packages/sdk'] }
  }
  const backendManifest = {
    name: '@paytray/backend',
    version: '0.1.0',
    dependencies: { ethers: backendDependency }
  }
  const sdkManifest = { name: '@paytray/sdk', version: '0.1.0' }
  const lockfile = {
    name: 'paytray',
    version: '0.1.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'paytray', version: '0.1.0', workspaces: { packages: ['packages/backend', 'packages/sdk'] } },
      'packages/backend': { name: '@paytray/backend', version: '0.1.0', dependencies: { ethers: backendDependency } },
      'packages/sdk': { name: '@paytray/sdk', version: '0.1.0' },
      'node_modules/ethers': { version: '6.17.0' }
    }
  }
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify(rootManifest))
  await fs.writeFile(path.join(root, 'packages/backend/package.json'), JSON.stringify(backendManifest))
  await fs.writeFile(path.join(root, 'packages/sdk/package.json'), JSON.stringify(sdkManifest))
  await fs.writeFile(path.join(root, 'package-lock.json'), JSON.stringify(lockfile))
  return root
}

describe('lockfile drift verification', () => {
  it('verifies the committed workspace manifests and lockfile', async () => {
    const report = await validateLockfileDrift({ projectRoot: REPO_ROOT })
    expect(report.status).toBe('verified')
    expect(report.driftDetected).toBe(false)
    expect(report.workspaces).toHaveLength(2)
    expect(report.fingerprint).toMatchObject({ algorithm: 'sha256', kind: 'paytray_lockfile_drift_v1' })
    expect(report.releaseEligible).toBe(false)
    expect(report.settlementAuthority).toBe(false)
    expect(report.mutation).toBe('read_only')
  })

  it('blocks a manifest range that differs from package-lock.json', async () => {
    const root = await writeFixture()
    try {
      await fs.writeFile(path.join(root, 'packages/backend/package.json'), JSON.stringify({
        name: '@paytray/backend',
        version: '0.1.0',
        dependencies: { ethers: '^2.0.0' }
      }))
      const report = await validateLockfileDrift({ projectRoot: root })
      expect(report.status).toBe('blocked')
      expect(report.driftDetected).toBe(true)
      expect(report.issues).toContain('packages/backend.dependencies.ethers differs from package-lock.json')
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
