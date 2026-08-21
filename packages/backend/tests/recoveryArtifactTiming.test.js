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

  it('accepts the allowlisted restored migration-017 extension-hook contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-017-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-017-extension-hooks.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '017_extension_hooks',
        databaseIsolation: true,
        cases: { catalog: { status: 'passed' }, deactivationRace: { status: 'passed', winners: 1, losers: 1 } },
        cleanupHooks: 6,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-017-extension-hooks.json']).toMatchObject({ status: 'verified', migration: '017_extension_hooks', databaseIsolation: true })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('accepts the allowlisted restored migration-018 concurrency contract', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-migration-018-concurrency-'))
    try {
      const artifactPath = path.join(directory, 'restored-migration-018-concurrency.json')
      await fs.writeFile(artifactPath, JSON.stringify({
        status: 'verified',
        migration: '018_operations_quality_runs',
        concurrency: { attempts: 8, repetitions: 3, totalAttempts: 24, validRuns: 3 },
        runs: [],
        cleanupRuns: 3,
        databaseIsolation: true,
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        valid: true
      }))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['restored-migration-018-concurrency.json']).toMatchObject({ status: 'verified', migration: '018_operations_quality_runs', databaseIsolation: true })
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

  const databaseTelemetry = {
    basis: 'postgresql_observability',
    sampleCount: 2,
    connectionAcquisitionMs: { count: 2, p50: 2, p95: 3, p99: 3, max: 3, mean: 2.5 },
    waitEvents: {
      sampleCount: 2,
      observations: [{ waitEventType: 'IO', waitEvent: 'DataFileRead', state: 'active', observations: 2, observedBackendCount: 3 }]
    },
    databaseStats: {
      before: { databaseSizeBytes: 100, tempBytes: 10, tempFiles: 1, blocksRead: 2, blocksHit: 3 },
      after: { databaseSizeBytes: 120, tempBytes: 110, tempFiles: 3, blocksRead: 7, blocksHit: 9 },
      deltas: { databaseSizeBytes: 20, tempBytes: 100, tempFiles: 2, blocksRead: 5, blocksHit: 6 }
    },
    temporaryStorage: { tempBytesDelta: 100, tempFilesDelta: 2, throughputBytesPerSecond: 1000, operationElapsedMs: 100 },
    errors: []
  }

  const storageTelemetry = {
    basis: 'local_disposable_backup_file',
    backupBytes: 1000,
    backupDurationMs: 20,
    backupWriteThroughputBytesPerSecond: 50000
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

  it('accepts PostgreSQL and backup-storage telemetry with bounded fields', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-database-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        database: databaseTelemetry,
        storage: storageTelemetry
      })))
      const result = await validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })
      expect(result.status).toBe('verified')
      expect(result.artifacts['recovery-evidence.json'].timing.database).toMatchObject({ basis: 'postgresql_observability', waitEventCount: 1 })
      expect(result.artifacts['recovery-evidence.json'].timing.storage.backupBytes).toBe(1000)
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  it('rejects a database telemetry observation with a negative count', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-recovery-database-'))
    try {
      const artifactPath = path.join(directory, 'recovery-evidence.json')
      await fs.writeFile(artifactPath, JSON.stringify(recoveryArtifact({
        startedAt: '2026-08-18T23:00:00.000Z',
        completedAt: '2026-08-18T23:00:02.000Z',
        elapsedMs: 2000,
        phases: { restore: { status: 'ok', durationMs: 2000 } },
        rto: { targetMs: null, targetConfigured: false, withinTarget: null, basis: 'not_configured' },
        database: {
          ...databaseTelemetry,
          waitEvents: {
            ...databaseTelemetry.waitEvents,
            observations: [{ ...databaseTelemetry.waitEvents.observations[0], observedBackendCount: -1 }]
          }
        }
      })))
      await expect(validateRecoveryArtifactBundle({ artifactPaths: [artifactPath] })).rejects.toThrow('observedBackendCount must be a nonnegative integer')
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
