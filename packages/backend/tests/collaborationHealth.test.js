import { describe, expect, it } from 'vitest'
import { buildCollaborationHealth } from '../lib/collaborationHealth.js'

describe('collaboration health', () => {
  it('keeps collaboration available when payment or verifier dependencies degrade', () => {
    const report = buildCollaborationHealth({ env: 'production', databaseStatus: 'ready', livekitStatus: 'ready', sessionAuthStatus: 'ready', paymentRpcStatus: 'error', verifierStatus: 'stale', indexerStatus: 'not_configured' })
    expect(report).toMatchObject({ status: 'degraded', ready: true, collaborationAvailable: true, mode: 'collaboration_available_payment_degraded', paymentStateMayBeStale: true, settlementAuthority: false, mutation: 'read_only' })
    expect(report.checks.paymentDependency.blocksCollaboration).toBe(false)
    expect(report.checks.engagementStore.blocksCollaboration).toBe(false)
  })

  it('blocks collaboration when durable engagement storage or session authorization is unavailable', () => {
    const databaseBlocked = buildCollaborationHealth({ env: 'production', databaseStatus: 'error', livekitStatus: 'ready', sessionAuthStatus: 'ready' })
    expect(databaseBlocked).toMatchObject({ status: 'blocked', ready: false, collaborationAvailable: false, mode: 'collaboration_blocked' })
    expect(databaseBlocked.checks.engagementStore.blocksCollaboration).toBe(true)

    const authBlocked = buildCollaborationHealth({ env: 'production', databaseStatus: 'ready', livekitStatus: 'ready', sessionAuthStatus: 'error' })
    expect(authBlocked.ready).toBe(false)
    expect(authBlocked.checks.sessionAuth.blocksCollaboration).toBe(true)
  })

  it('allows development fallback to be visibly degraded rather than falsely ready', () => {
    const report = buildCollaborationHealth({ env: 'development', databaseStatus: 'unconfigured', livekitStatus: 'not_configured', sessionAuthStatus: 'unconfigured' })
    expect(report).toMatchObject({ status: 'degraded', ready: true, collaborationAvailable: true, paymentStateMayBeStale: true })
    expect(report.checks.engagementStore.reason).toContain('in-memory fallback')
    expect(report.checks.realtimeTransport.blocksCollaboration).toBe(false)
  })
})
