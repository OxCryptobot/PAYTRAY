import { describe, expect, it } from 'vitest'
import { buildOperatorHealthDashboard } from '../lib/operatorHealthDashboard.js'

const healthyRuntime = {
  status: 'ok',
  ready: true,
  blockers: [],
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only'
}
const healthyOutbox = { status: 'ok', mutation: 'read_only', settlementAuthority: false }
const healthyInbox = { status: 'ok', mutation: 'read_only', settlementAuthority: false }
const healthyVerifier = { status: 'ready', mutation: 'read_only', settlementAuthority: false }
const completeEvidence = {
  status: 'complete_pending_release_gate',
  evidenceComplete: true,
  releaseEligible: false,
  mutation: 'read_only',
  settlementAuthority: false
}

function build(overrides = {}) {
  return buildOperatorHealthDashboard({
    runtimeHealth: healthyRuntime,
    outboxHealth: healthyOutbox,
    webhookInboxHealth: healthyInbox,
    verifierOperations: healthyVerifier,
    unifiedEvidence: completeEvidence,
    now: new Date('2026-08-15T20:00:00.000Z'),
    ...overrides
  })
}

describe('operator health dashboard', () => {
  it('reports healthy only when every canonical component is healthy', () => {
    const result = build()

    expect(result).toMatchObject({
      status: 'ok',
      ready: true,
      generatedAt: '2026-08-15T20:00:00.000Z',
      summary: { total: 5, healthy: 5, blocked: 0, blockedComponents: [] },
      authority: 'operator_health_aggregation_only',
      paymentStateAuthority: 'verifier_and_ledger_only',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
    expect(result.components.map((component) => component.name)).toEqual([
      'runtimeHealth',
      'outbox',
      'webhookInbox',
      'verifier',
      'evidence'
    ])
  })

  it('classifies degraded delivery and verifier evidence without granting authority', () => {
    const result = build({
      outboxHealth: { status: 'attention', dead: 1 },
      webhookInboxHealth: { status: 'attention', quarantined: 2 },
      verifierOperations: { status: 'blocked', reason: 'verifier status is not_configured' },
      unifiedEvidence: { status: 'blocked', evidenceComplete: false, blockers: [{ name: 'verifier', reason: 'verifier evidence is incomplete' }] }
    })

    expect(result.status).toBe('degraded')
    expect(result.ready).toBe(false)
    expect(result.summary).toMatchObject({ total: 5, healthy: 1, blocked: 4 })
    expect(result.summary.blockedComponents).toEqual(['outbox', 'webhookInbox', 'verifier', 'evidence'])
    expect(result.blockers).toEqual([
      { name: 'outbox', status: 'attention', reason: 'durable outbox delivery requires attention' },
      { name: 'webhookInbox', status: 'attention', reason: 'durable webhook inbox requires attention' },
      { name: 'verifier', status: 'blocked', reason: 'verifier status is not_configured' },
      { name: 'evidence', status: 'blocked', reason: 'verifier evidence is incomplete' }
    ])
    expect(result.releaseEligible).toBe(false)
    expect(result.settlementAuthority).toBe(false)
    expect(result.mutation).toBe('read_only')
  })

  it('fails closed when a component is absent and retains immutable metadata', () => {
    const result = build({ unifiedEvidence: null })
    const evidenceComponent = result.components.find((component) => component.name === 'evidence')

    expect(result.status).toBe('degraded')
    expect(evidenceComponent).toMatchObject({ ready: false, status: 'unavailable' })
    expect(result.authority).toBe('operator_health_aggregation_only')
    expect(result.releaseEligible).toBe(false)
    expect(result.settlementAuthority).toBe(false)
    expect(result.deploymentPerformed).toBe(false)
    expect(result.settlementMutationPerformed).toBe(false)
  })
})
