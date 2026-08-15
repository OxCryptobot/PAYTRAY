import { describe, expect, it } from 'vitest'
import { getExtensionContractCapabilities, normalizeExtensionHookInput, projectExtensionPayload, stripForbiddenContent } from '../lib/extensionContracts.js'

describe('versioned public extension contracts', () => {
  it('exposes bounded v2 capabilities with signed retryable delivery and no settlement authority', () => {
    expect(getExtensionContractCapabilities()).toMatchObject({ apiVersion: 'v2', contractVersion: '2026-08-15', delivery: { signed: true, retryable: true, deadLetterObservable: true, replayWindowBounded: true }, settlementAuthority: false, mutation: 'read_only' })
    expect(getExtensionContractCapabilities().supportedEvents).toEqual(expect.arrayContaining(['ai.shadow_review_recorded', 'ai.shadow_review_replayed']))
  })

  it('normalizes an allowed hook with bounded projections and replay window', () => {
    const hook = normalizeExtensionHookInput({ event: 'payment.chain_event_projected', callbackUrl: 'https://example.com/hook', projections: ['identifiers', 'lifecycle', 'identifiers'], replayWindowSeconds: 600 })
    expect(hook).toMatchObject({ apiVersion: 'v2', event: 'payment.chain_event_projected', projections: ['identifiers', 'lifecycle'], replayWindowSeconds: 600, delivery: { signed: true } })
  })

  it('normalizes reviewer-audit events for bounded public delivery', () => {
    const hook = normalizeExtensionHookInput({ event: 'ai.shadow_review_recorded', callbackUrl: 'https://example.com/reviewer-hook', projections: ['identifiers', 'lifecycle', 'provenance'] })
    const projected = projectExtensionPayload({ hook, payload: { runId: 'run-1', reviewerNotesHash: 'hash', reviewerNotes: 'private', applied: false, promotionStatus: 'shadow_only' } })
    expect(projected.event).toBe('ai.shadow_review_recorded')
    expect(projected.data.identifiers.runId).toBe('run-1')
    expect(JSON.stringify(projected)).not.toContain('private')
  })

  it('rejects unsupported events, projections, and unbounded replay windows', () => {
    expect(() => normalizeExtensionHookInput({ event: 'payment.settle_now', callbackUrl: 'https://example.com/hook' })).toThrow('event must be one of')
    expect(() => normalizeExtensionHookInput({ event: 'engagement.created', callbackUrl: 'https://example.com/hook', projections: ['raw_content'] })).toThrow('projections must contain only')
    expect(() => normalizeExtensionHookInput({ event: 'engagement.created', callbackUrl: 'https://example.com/hook', replayWindowSeconds: 10 })).toThrow('replayWindowSeconds')
  })

  it('strips forbidden raw fields from delivery projections while preserving safe evidence', () => {
    const hook = normalizeExtensionHookInput({ event: 'engagement.created', callbackUrl: 'https://example.com/hook', projections: ['identifiers', 'lifecycle', 'provenance', 'metrics'] })
    const projected = projectExtensionPayload({ hook, payload: { engagementId: 'eng-1', status: 'active', sourceEventId: 'event-1', message: 'private', nested: { transcript: 'private' }, latencyMs: 42 } })
    expect(projected.data.identifiers.engagementId).toBe('eng-1')
    expect(projected.data.lifecycle.status).toBe('active')
    expect(projected.data.provenance.sourceEventId).toBe('event-1')
    expect(projected.data.metrics.latencyMs).toBe(42)
    expect(JSON.stringify(projected)).not.toContain('private')
    expect(stripForbiddenContent({ body: 'private', safe: true })).toEqual({ safe: true })
  })
})
