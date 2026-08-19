import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { validateRecoveryArtifactBundle } from '../scripts/verify-recovery-artifact.mjs'

function recoveryArtifact(timing) {
  return {
    reportKind: 'recovery_evidence',
    status: 'verified',
    sourceDatabase: 'postgresql://127.0.0.1/paytray_ci',
    backup: {
      path: '/tmp/paytray-recovery.dump',
      bytes: 100,
      sha256: 'a'.repeat(64),
      catalogEntries: 10,
      format: 'custom',
      ownerAndPrivilegesExcluded: true
    },
    restore: {
      status: 'verified',
      tableCount: 37,
      migrationCount: 19,
      database: 'postgresql://127.0.0.1/paytray_recovery_ci'
    },
    authority: 'recovery_evidence_only',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'isolated_recovery_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    timing
  }
}

describe('recovery artifact timing contract', () => {
  it('accepts measured timing with an internally consistent operator RTO target', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-timing-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { backup: { status: 'ok', durationMs: 1200 }, restore: { status: 'ok', durationMs: 800 } },
        rto: { targetMs: 5000, targetConfigured: true, withinTarget: true, basis: 'operator_supplied' }
      })))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing).toEqual({
        elapsedMs: 2000,
        phaseCount: 2,
        targetConfigured: true,
        withinTarget: true
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects an RTO result that contradicts elapsed time', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-timing-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:06.000Z',
        elapsedMs: 6000,
        phases: { restore: { status: 'ok', durationMs: 6000 } },
        rto: { targetMs: 5000, targetConfigured: true, withinTarget: true, basis: 'operator_supplied' }
      })))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('withinTarget is inconsistent')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})


describe('recovery artifact resource telemetry contract', () => {
  const resourceSample = {
    basis: 'node_process_resource_usage',
    rssBytes: 1000,
    rssDeltaBytes: 100,
    heapUsedBytes: 500,
    externalBytes: 50,
    arrayBuffersBytes: 20,
    peakRssKb: 200,
    userCpuTimeUs: 30,
    systemCpuTimeUs: 10,
    fsReadOps: 2,
    fsWriteOps: 3,
    voluntaryContextSwitches: 1,
    involuntaryContextSwitches: 0
  }

  it('accepts process and phase resource telemetry', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-resource-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        resource: {
          basis: 'node_process_resource_usage',
          process: resourceSample,
          phases: { restore: resourceSample }
        }
      })))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing.resource.phases.restore.fieldCount).toBe(12)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a resource sample with a negative metric', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-resource-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        resource: {
          basis: 'node_process_resource_usage',
          process: { ...resourceSample, rssBytes: -1 },
          phases: { restore: resourceSample }
        }
      })))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('rssBytes must be a nonnegative integer')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})


describe('recovery artifact child-process telemetry contract', () => {
  const timingWithChild = (overrides = {}) => ({
    startedAt: '2026-08-18T23:00:00.000Z',
    completedAt: '2026-08-18T23:00:02.000Z',
    elapsedMs: 2000,
    phases: { restore: { status: 'ok', durationMs: 2000 } },
    rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
    childProcesses: {
      restore: {
        basis: 'procfs_child_process',
        clockTickHz: 100,
        elapsedMs: 400.25,
        userCpuTimeMs: 30.5,
        systemCpuTimeMs: 4.25,
        peakRssKb: 12000,
        exitCode: 0,
        signal: null,
        ...overrides
      }
    }
  })

  it('accepts a successful procfs restore child report', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-child-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact(timingWithChild())))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing.childProcesses.restore).toMatchObject({
        basis: 'procfs_child_process',
        elapsedMs: 400.25,
        peakRssKb: 12000
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a child report with a nonzero exit code', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-child-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact(timingWithChild({ exitCode: 1 }))))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('must have a successful process exit')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
