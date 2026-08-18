import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAdvisoryAiEvidence } from '../scripts/verify-advisory-ai-evidence.mjs'

const releaseCommit = 'a'.repeat(40)

function writeFixture(root, report) {
  const filePath = path.join(root, 'advisory-ai.json')
  fs.writeFileSync(filePath, JSON.stringify(report), { mode: 0o600 })
  return filePath
}

function baseReport(overrides = {}) {
  return {
    reportKind: 'advisory_ai_evidence',
    status: 'ready',
    capabilities: {
      enabled: true,
      providerConfigured: true,
      providerName: 'bounded-provider',
      modelName: 'bounded-model',
      maxLatencyMs: 5000,
      maxCostMicrounits: 1000,
      maxRetrievalItems: 20,
      retentionDays: 30,
      rawContentPersistence: false,
      humanReviewRequired: true,
      promotionStatus: 'shadow_only',
      settlementAuthority: false,
      applied: false,
      mutation: 'read_only'
    },
    promotionStatus: 'shadow_only',
    humanOverrideRequired: true,
    rawContentPersisted: false,
    applied: false,
    mutation: 'read_only',
    releaseEligible: false,
    settlementAuthority: false,
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    releaseCommit,
    ...overrides
  }
}

describe('advisory-AI evidence verifier', () => {
  it('verifies complete bounded capability evidence without granting authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-advisory-evidence-'))
    try {
      const result = buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, baseReport()), target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ reportKind: 'advisory_ai_evidence_verification', status: 'verified_reference', target: 'local_disposable', releaseCommit, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', applied: false })
      expect(Object.values(result.capabilityChecks).every(Boolean)).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps disabled or incomplete advisory-AI evidence blocked', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-advisory-blocked-'))
    try {
      const result = buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, baseReport({ status: 'blocked', capabilities: { ...baseReport().capabilities, enabled: false } })), target: 'local_disposable', releaseCommit })
      expect(result).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
      expect(result.capabilityChecks.enabled).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects raw-content and authority-positive fields', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-advisory-sensitive-'))
    try {
      expect(() => buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, { ...baseReport(), transcript: 'never' }), target: 'local_disposable', releaseCommit })).toThrow('sensitive key')
      expect(() => buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, baseReport({ applied: true })), target: 'local_disposable', releaseCommit })).toThrow('immutable safety fields')
      expect(() => buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, baseReport({ promotionStatus: 'promoted' })), target: 'local_disposable', releaseCommit })).toThrow('shadow-only boundary')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('binds evidence to the exact release commit and enforces authenticated protected paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-advisory-paths-'))
    try {
      expect(() => buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, baseReport({ releaseCommit: 'b'.repeat(40) })), target: 'local_disposable', releaseCommit })).toThrow('does not match')
      expect(() => buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, baseReport()), target: 'authenticated_target', releaseCommit })).toThrow('inside the protected evidence root')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects invalid latency, retrieval, and retention budgets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-advisory-budgets-'))
    try {
      const report = baseReport({ capabilities: { ...baseReport().capabilities, maxLatencyMs: 0, maxRetrievalItems: 101, retentionDays: 0 } })
      const result = buildAdvisoryAiEvidence({ evidenceFile: writeFixture(root, report), target: 'local_disposable', releaseCommit })
      expect(result.status).toBe('blocked')
      expect(result.capabilityChecks.latencyBudgetValid).toBe(false)
      expect(result.capabilityChecks.retrievalBudgetValid).toBe(false)
      expect(result.capabilityChecks.retentionBudgetValid).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
