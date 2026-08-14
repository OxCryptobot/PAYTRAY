import { describe, expect, it } from 'vitest'
import { buildReleaseApprovalArtifact } from '../lib/releaseApprovalGate.js'

const base = {
  deploymentPreflight: { ready: true, settlement: { chainId: 84532, mainnetEnabled: false }, checks: [] },
  readiness: { checks: { database: { ready: true } } },
  reconciliation: { status: 'ok', summary: { issues: 0 } },
  verifierStatus: { status: 'fresh', ready: true },
  pendingShadowReviews: 0,
  rollbackTargets: 1
}

describe('release approval gate', () => {
  it('fails closed until explicit human approval is supplied', () => {
    const artifact = buildReleaseApprovalArtifact(base)
    expect(artifact).toMatchObject({ status: 'blocked', eligible: false, approvalRequired: true, promotionStatus: 'shadow_only', authority: 'human_approval_required', mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false })
    expect(artifact.checks.find((check) => check.name === 'humanApproval')).toMatchObject({ ready: false })
  })

  it('approves only when all operational evidence and explicit human approval are present', () => {
    const artifact = buildReleaseApprovalArtifact({ ...base, humanApproval: { approved: true, reviewerId: 'operator-1', approvedAt: '2026-08-14T22:00:00.000Z' } })
    expect(artifact.status).toBe('approved')
    expect(artifact.eligible).toBe(true)
    expect(artifact.checks.every((check) => check.ready)).toBe(true)
  })

  it('blocks stale verifier or unresolved reconciliation evidence', () => {
    const artifact = buildReleaseApprovalArtifact({ ...base, verifierStatus: { status: 'stale', ready: false }, reconciliation: { status: 'attention', summary: { issues: 1 } }, humanApproval: { approved: true } })
    expect(artifact.status).toBe('blocked')
    expect(artifact.checks.find((check) => check.name === 'verifier').ready).toBe(false)
    expect(artifact.checks.find((check) => check.name === 'reconciliation').ready).toBe(false)
  })
})
