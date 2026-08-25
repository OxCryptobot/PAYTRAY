import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const cliScript = path.resolve(process.cwd(), 'scripts/verify-durable-worker-evidence.mjs')

function runCli(directory, overrides = {}) {
  const defaults = {
    OUTBOX_HEALTH_FILE: path.join(directory, 'outbox-health.json'),
    OUTBOX_WORKER_CONFIG_FILE: path.join(directory, 'outbox-worker.json'),
    IDEMPOTENCY_CLEANUP_CONFIG_FILE: path.join(directory, 'idempotency.json'),
    DURABLE_WORKER_EVIDENCE_TARGET: 'local_disposable'
  }
  return spawnSync(process.execPath, [cliScript], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: '', ...defaults, ...overrides }
  })
}

function readReport(result) {
  expect(result.status).toBe(1)
  return JSON.parse(result.stdout)
}

describe('durable-worker evidence CLI input identity', () => {
  it('rejects symlinked and non-regular evidence files before JSON ingestion', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-durable-worker-inputs-'))
    try {
      const healthPath = path.join(directory, 'outbox-health.json')
      const workerPath = path.join(directory, 'outbox-worker.json')
      const idempotencyPath = path.join(directory, 'idempotency.json')
      const healthLinkPath = path.join(directory, 'outbox-health-link.json')
      const workerDirectoryPath = path.join(directory, 'outbox-worker-directory')
      fs.writeFileSync(healthPath, JSON.stringify({ status: 'ok' }))
      fs.writeFileSync(workerPath, JSON.stringify({ status: 'ready' }))
      fs.writeFileSync(idempotencyPath, JSON.stringify({ status: 'ready' }))
      fs.symlinkSync(healthPath, healthLinkPath)
      fs.mkdirSync(workerDirectoryPath)

      const symlinkReport = readReport(runCli(directory, { OUTBOX_HEALTH_FILE: healthLinkPath }))
      expect(symlinkReport).toMatchObject({
        status: 'operator_blocked',
        reason: 'OUTBOX_HEALTH_FILE file must not be a symlink',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'durable_worker_evidence_aggregation_only'
      })

      const directoryReport = readReport(runCli(directory, { OUTBOX_WORKER_CONFIG_FILE: workerDirectoryPath }))
      expect(directoryReport).toMatchObject({
        status: 'operator_blocked',
        reason: 'OUTBOX_WORKER_CONFIG_FILE file must be a regular file',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'durable_worker_evidence_aggregation_only'
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
