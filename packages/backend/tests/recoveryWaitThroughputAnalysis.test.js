import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { analyzeRecoveryWaitThroughput } from '../scripts/analyze-recovery-wait-throughput.mjs'

const COMMIT = 'b097e2c80bdfbd2fb6efe8fd53fca3110dec0bf4'
const backendDirectory = process.cwd()
const waitThroughputScriptPath = path.join(backendDirectory, 'scripts', 'analyze-recovery-wait-throughput.mjs')

function sampleReport(concurrency, { unsafe = false, target = false, commit = COMMIT } = {}) {
  const workers = Array.from({ length: concurrency }, (_, index) => ({
    workerId: `worker-${index + 1}`,
    databaseTelemetry: {
      waitEvents: {
        observations: [
          { waitEventType: 'IO', waitEvent: 'DataFileImmediateSync', state: 'active', observations: index + 1, observedBackendCount: index + 1 },
          { waitEventType: 'LWLock', waitEvent: 'WALWrite', state: 'active', observations: 2, observedBackendCount: 2 }
        ]
      }
    }
  }))
  return {
    reportKind: 'local_disposable_recovery_stress',
    status: 'verified',
    releaseCommit: commit,
    environment: 'local_disposable',
    concurrency,
    requestedSequences: concurrency,
    completedSequences: concurrency,
    failedSequences: 0,
    integrityFailures: 0,
    orchestrationElapsedMs: concurrency * 100,
    throughputPerSecond: null,
    sequenceElapsedMs: { count: concurrency, p50: 100, p95: 110, p99: 111, max: 112, mean: 105 },
    phaseLatencyMs: { restore: { count: concurrency, p50: 10, p95: 12, p99: 13, max: 14, mean: 11 } },
    databaseTelemetry: {
      basis: 'postgresql_observability',
      sampleCount: concurrency * 10,
      connectionAcquisitionMs: { max: 4 },
      waitEvents: {
        observations: [
          { waitEventType: 'IO', waitEvent: 'DataFileImmediateSync', state: 'active', observations: concurrency * 2, observedBackendCount: concurrency * 2 },
          { waitEventType: 'LWLock', waitEvent: 'WALWrite', state: 'active', observations: concurrency, observedBackendCount: concurrency }
        ]
      }
    },
    workers,
    rto: { targetMs: target ? 1 : null, targetConfigured: target, withinTarget: target ? false : null },
    releaseEligible: unsafe ? true : false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

async function writeReports(reports) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-throughput-'))
  const paths = []
  for (const report of reports) {
    const filePath = path.join(directory, `c${report.concurrency}.json`)
    await fs.writeFile(filePath, JSON.stringify(report))
    paths.push(filePath)
  }
  return { directory, paths }
}

describe('recovery wait-throughput analysis', () => {
  it('derives sequence throughput and reports descriptive wait-signal rates', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency)))
    try {
      const report = await analyzeRecoveryWaitThroughput({ reportPaths: fixture.paths, expectedCommit: COMMIT })
      expect(report.status).toBe('verified')
      expect(report.levels[0].throughput.derivedThroughputPerSecond).toBe(10)
      expect(report.levels[2].throughput.derivedThroughputPerSecond).toBe(10)
      expect(report.levels[2].levels).toBeUndefined()
      expect(report.levels[2].scaling.efficiencyVsLinearPercent).toBe(25)
      expect(report.levels[2].signals.dataFileImmediateSync.observations).toBe(16)
      expect(report.levels[2].signals.lwLockWalWrite.observations).toBe(8)
      expect(report.interpretation).toMatchObject({ status: 'descriptive_only', transactionThroughputMeasured: false, causalInference: false })
      expect(report.releaseEligible).toBe(false)
      expect(report.settlementAuthority).toBe(false)
      expect(report.mutation).toBe('read_only')
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects symlinked and non-regular report inputs in the CLI before parsing', async () => {
    const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency)))
    const inputDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'paytray-throughput-inputs-'))
    try {
      const symlinkPath = path.join(inputDirectory, 'c2-link.json')
      const directoryPath = path.join(inputDirectory, 'c2-directory')
      await fs.symlink(fixture.paths[0], symlinkPath)
      await fs.mkdir(directoryPath)

      for (const [inputPath, reason] of [[symlinkPath, `${symlinkPath} must not be a symlink`], [directoryPath, `${directoryPath} must be a regular file`]]) {
        const reportPaths = [inputPath, fixture.paths[1], fixture.paths[2]].join(',')
        let error
        try {
          execFileSync(process.execPath, [waitThroughputScriptPath], {
            cwd: backendDirectory,
            encoding: 'utf8',
            env: { ...process.env, RECOVERY_STRESS_REPORTS: reportPaths, RECOVERY_STRESS_EXPECTED_COMMIT: COMMIT }
          })
        } catch (caught) {
          error = caught
        }
        expect(error?.status).toBe(1)
        expect(JSON.parse(error?.stderr || error?.stdout)).toMatchObject({ reportKind: 'local_disposable_recovery_wait_throughput_analysis', status: 'blocked', reason, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
      }
    } finally {
      await fs.rm(inputDirectory, { recursive: true, force: true })
      await fs.rm(fixture.directory, { recursive: true, force: true })
    }
  })

  it('rejects target-bound reports and unsafe authority fields', async () => {
    for (const options of [{ target: true }, { unsafe: true }]) {
      const fixture = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, options)))
      try {
        await expect(analyzeRecoveryWaitThroughput({ reportPaths: fixture.paths, expectedCommit: COMMIT })).rejects.toThrow(options.target ? 'must use null-target RTO semantics' : 'has unsafe authority fields')
      } finally {
        await fs.rm(fixture.directory, { recursive: true, force: true })
      }
    }
  })

  it('rejects commit mismatches and incomplete concurrency levels', async () => {
    const mismatch = await writeReports([2, 4, 8].map((concurrency) => sampleReport(concurrency, { commit: concurrency === 8 ? 'ea78e6677f86532dedae0a55045c731d325558a6' : COMMIT })))
    try {
      await expect(analyzeRecoveryWaitThroughput({ reportPaths: mismatch.paths, expectedCommit: COMMIT })).rejects.toThrow('unexpected commit')
    } finally {
      await fs.rm(mismatch.directory, { recursive: true, force: true })
    }
    const incomplete = await writeReports([2, 4].map((concurrency) => sampleReport(concurrency)))
    try {
      await expect(analyzeRecoveryWaitThroughput({ reportPaths: incomplete.paths, expectedCommit: COMMIT })).rejects.toThrow('one report per expected concurrency')
    } finally {
      await fs.rm(incomplete.directory, { recursive: true, force: true })
    }
  })
})
