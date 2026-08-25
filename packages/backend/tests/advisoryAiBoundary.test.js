import { describe, expect, it } from 'vitest'
import { createAdvisoryAiRequest, getAdvisoryAiCapabilities, runBoundedAdvisory } from '../lib/advisoryAiBoundary.js'

const config = {
  advisoryAi: {
    enabled: true,
    providerName: 'test-provider',
    modelName: 'test-model',
    maxLatencyMs: 100,
    maxCostMicrounits: 100,
    maxRetrievalItems: 2,
    retentionDays: 7,
    rawContentPersistence: false
  }
}

function makeRequest(overrides = {}) {
  return createAdvisoryAiRequest({
    taskType: 'conversation_assistance',
    subject: { engagementId: 'engagement-1', featureVersion: 'context-v1', features: { urgency: 0.4 } },
    retrievalItems: [{ id: 'evidence-1', sourceType: 'verified_outcome', sourceId: 'outcome-1', score: 0.9 }],
    provenance: { sourceEventIds: ['outcome-1'], source: 'verified_lineage' },
    config,
    ...overrides
  })
}

describe('advisory AI boundary', () => {
  it('returns explicit capabilities with no settlement or promotion authority', () => {
    expect(getAdvisoryAiCapabilities({ config })).toMatchObject({
      enabled: true,
      providerConfigured: true,
      humanReviewRequired: true,
      promotionStatus: 'shadow_only',
      settlementAuthority: false,
      rawContentPersistence: false,
      mutation: 'read_only'
    })
  })

  it('normalizes retrieval to evidence references and hashes the bounded request', () => {
    const request = makeRequest()
    expect(request).toMatchObject({ taskType: 'conversation_assistance', rawContentPersisted: false, humanOverrideRequired: true, promotionStatus: 'shadow_only', settlementAuthority: false, mutation: 'read_only' })
    expect(request.inputHash).toHaveLength(64)
    expect(request.retrievalEvidence[0]).toEqual({ id: 'evidence-1', sourceType: 'verified_outcome', sourceId: 'outcome-1', score: 0.9, featureVersion: null, evidenceHash: null })
  })

  it('rejects raw content and missing provenance', () => {
    expect(() => makeRequest({ subject: { engagementId: 'engagement-1', message: 'do not persist' } })).toThrow('subject.message')
    expect(() => makeRequest({ provenance: { source: 'missing-event-id' } })).toThrow('sourceEventIds')
  })

  it('returns an advisory result only within latency and cost budgets', async () => {
    const result = await runBoundedAdvisory({
      provider: { async complete() { return { output: { guidance: 'prepare agenda' }, costMicrounits: 20 } } },
      request: makeRequest(),
      config
    })
    expect(result).toMatchObject({ status: 'advisory', latencyMs: expect.any(Number), costMicrounits: 20, humanOverrideRequired: true, applied: false, promotionStatus: 'shadow_only', settlementAuthority: false, rawContentPersisted: false, mutation: 'read_only' })
  })

  it('blocks missing providers, timeouts, and cost overruns', async () => {
    const request = makeRequest()
    expect((await runBoundedAdvisory({ provider: null, request, config })).status).toBe('blocked')
    const timeoutConfig = { ...config, advisoryAi: { ...config.advisoryAi, maxLatencyMs: 5 } }
    const timeout = await runBoundedAdvisory({ provider: { async complete() { await new Promise((resolve) => setTimeout(resolve, 20)); return { output: {}, costMicrounits: 1 } } }, request, config: timeoutConfig })
    expect(timeout).toMatchObject({ status: 'blocked', promotionStatus: 'shadow_only', settlementAuthority: false })
    const overBudget = await runBoundedAdvisory({ provider: { async complete() { return { output: {}, costMicrounits: 101 } } }, request, config })
    expect(overBudget).toMatchObject({ status: 'blocked', reason: 'advisory AI provider exceeded cost budget' })
  })

  it('blocks primitive and array provider outputs before they cross the advisory boundary', async () => {
    const request = makeRequest()
    for (const output of ['raw provider content', ['not', 'an', 'object']]) {
      const result = await runBoundedAdvisory({ provider: { async complete() { return { output, costMicrounits: 1 } } }, request, config })
      expect(result).toMatchObject({ status: 'blocked', reason: 'provider response output must be an object', rawContentPersisted: false, humanOverrideRequired: true, applied: false, promotionStatus: 'shadow_only', settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
    }
  })
})
