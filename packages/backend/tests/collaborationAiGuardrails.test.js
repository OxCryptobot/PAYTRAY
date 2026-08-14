import { describe, expect, it } from 'vitest'
import { createCollaborationAdvisoryGuardrails } from '../lib/collaborationAiGuardrails.js'

const future = '2099-01-01T00:00:00.000Z'

describe('collaboration AI guardrails', () => {
  it('creates non-applied, provenance-backed advisory evidence', () => {
    const result = createCollaborationAdvisoryGuardrails({
      provenance: { sourceEventIds: ['engagement-1', 'outcome-1'], featureVersion: 'collab-v1' },
      retentionUntil: future,
      latencyMs: 1200,
      costMicrounits: 42,
      output: { reasonCodes: ['agenda_help'] }
    })
    expect(result).toMatchObject({ taskType: 'conversation_assistance', applied: false, humanOverrideRequired: true, settlementAuthority: false, rawContentPersisted: false })
    expect(result.provenance.sourceEventIds).toEqual(['engagement-1', 'outcome-1'])
  })

  it('rejects raw collaboration content and unsafe operational bounds', () => {
    expect(() => createCollaborationAdvisoryGuardrails({ provenance: { sourceEventIds: ['event-1'], transcript: 'secret' }, retentionUntil: future, latencyMs: 1, costMicrounits: 1 })).toThrow('cannot be persisted')
    expect(() => createCollaborationAdvisoryGuardrails({ provenance: { sourceEventIds: ['event-1'] }, retentionUntil: future, latencyMs: 60001, costMicrounits: 1 })).toThrow('latencyMs')
    expect(() => createCollaborationAdvisoryGuardrails({ provenance: { sourceEventIds: ['event-1'] }, retentionUntil: future, latencyMs: 1, costMicrounits: 1.5 })).toThrow('costMicrounits')
  })
})
