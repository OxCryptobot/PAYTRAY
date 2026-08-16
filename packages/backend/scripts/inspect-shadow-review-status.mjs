import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import { listShadowRuns } from '../lib/shadowReviewService.js'
import { buildShadowReviewStatusSnapshot } from '../lib/shadowReviewStatusSnapshot.js'

const EXPECTED_RUN_IDS = [
  'd9280263-932b-45b0-a173-ed3e7e2dcb3c',
  '5d85ded6-4842-4091-85f3-8046e90c7b79',
  'eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49',
  '3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a',
  'c25b2bee-4fac-4f87-acf3-00541a093030',
  '7b0f934d-8bda-4b10-aa4c-d7fc019078e4'
]

let exitCode = 1
try {
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') throw new Error('shadow review status requires a ready PostgreSQL database')
  const snapshot = await transaction(async (client) => {
    const pending = await listShadowRuns({ client, reviewerDecision: 'pending', limit: 100 })
    const approved = await listShadowRuns({ client, reviewerDecision: 'approved_pilot', limit: 100 })
    const rejected = await listShadowRuns({ client, reviewerDecision: 'rejected', limit: 100 })
    return buildShadowReviewStatusSnapshot({ runs: [...pending.runs, ...approved.runs, ...rejected.runs], expectedRunIds: EXPECTED_RUN_IDS })
  })
  console.log(JSON.stringify(snapshot, null, 2))
  exitCode = snapshot.status === 'incomplete' ? 1 : 0
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    submissionPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    authority: 'shadow_review_status_inspection_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  exitCode = 1
} finally {
  await closeDatabase().catch(() => {})
}
process.exitCode = exitCode
