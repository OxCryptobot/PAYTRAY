import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const REQUIRED_SIGNOFF_ROLES = ['release_operator', 'protocol_finance', 'ai_data', 'security']
const PENDING_SHADOW_RUN_IDS = [
  'd9280263-932b-45b0-a173-ed3e7e2dcb3c',
  '5d85ded6-4842-4091-85f3-8046e90c7b79',
  'eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49',
  '3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a',
  'c25b2bee-4fac-4f87-acf3-00541a093030',
  '7b0f934d-8bda-4b10-aa4c-d7fc019078e4'
]
const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|transcript|recording|audio|video)/i
const PLACEHOLDER = /<[^>]+>|TODO|TBD|REPLACE_ME|EXAMPLE_ONLY/i

function fail(message) {
  throw new Error(message)
}

function assertSafeTree(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeTree(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && PLACEHOLDER.test(value)) fail(`placeholder text is not allowed at ${path}`)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive field is not allowed at ${path}.${key}`)
    assertSafeTree(child, `${path}.${key}`)
  }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || PLACEHOLDER.test(value)) fail(`${field} must contain real non-placeholder text`)
  return value.trim()
}

function validTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO-8601 timestamp`)
}

function assertRegularNonSymlinkFile(filePath) {
  let stats
  try {
    stats = fs.lstatSync(filePath)
  } catch (error) {
    fail(`human-evidence worksheet file cannot be inspected: ${error.message}`)
  }
  if (stats.isSymbolicLink()) fail('human-evidence worksheet file must not be a symlink')
  if (!stats.isFile()) fail('human-evidence worksheet file must be a regular file')
}

export function validateHumanEvidenceWorksheet({ content } = {}) {
  if (content == null) throw new TypeError('content is required')
  let worksheet
  try {
    worksheet = typeof content === 'string' ? JSON.parse(content) : content
  } catch {
    fail('human-evidence worksheet is not valid JSON')
  }
  assertSafeTree(worksheet)
  if (!worksheet || typeof worksheet !== 'object' || Array.isArray(worksheet)) fail('human-evidence worksheet must be an object')
  const mode = worksheet.mode || 'submission'
  if (!['draft', 'submission'].includes(mode)) fail('human-evidence worksheet mode must be draft or submission')
  const signoffs = Array.isArray(worksheet.signoffs) ? worksheet.signoffs : []
  const shadows = Array.isArray(worksheet.shadowReviews) ? worksheet.shadowReviews : []
  const errors = []
  const roles = new Set()
  for (const [index, signoff] of signoffs.entries()) {
    try {
      if (!REQUIRED_SIGNOFF_ROLES.includes(signoff?.role)) fail(`signoffs[${index}].role is not one of the required roles`)
      if (roles.has(signoff.role)) fail(`duplicate sign-off role: ${signoff.role}`)
      roles.add(signoff.role)
      if (mode === 'draft') {
        if (signoff.approved === true || signoff.reviewerId || signoff.approvedAt || signoff.notes) fail(`draft signoffs[${index}] must not contain approval or reviewer evidence`)
        continue
      }
      if (signoff.approved !== true) fail(`signoffs[${index}].approved must be true for a release worksheet`)
      requiredString(signoff.reviewerId, `signoffs[${index}].reviewerId`)
      validTimestamp(signoff.approvedAt, `signoffs[${index}].approvedAt`)
      if (signoff.scope !== 'production_release') fail(`signoffs[${index}].scope must be production_release`)
      if (signoff.rollbackAcknowledged !== true) fail(`signoffs[${index}].rollbackAcknowledged must be true`)
      requiredString(signoff.evidenceReviewed, `signoffs[${index}].evidenceReviewed`)
      requiredString(signoff.rollbackTarget, `signoffs[${index}].rollbackTarget`)
      requiredString(signoff.notes, `signoffs[${index}].notes`)
    } catch (error) {
      errors.push(error.message)
    }
  }
  for (const role of REQUIRED_SIGNOFF_ROLES) if (!roles.has(role)) errors.push(`missing sign-off role: ${role}`)

  const runIds = new Set()
  for (const [index, review] of shadows.entries()) {
    try {
      if (!PENDING_SHADOW_RUN_IDS.includes(review?.runId)) fail(`shadowReviews[${index}].runId is not one of the six pending runs`)
      if (runIds.has(review.runId)) fail(`duplicate shadow run: ${review.runId}`)
      runIds.add(review.runId)
      if (mode === 'draft') {
        if (review.decision && review.decision !== 'pending') fail(`draft shadowReviews[${index}] must not contain a terminal decision`)
        if (review.reviewerId || review.reviewedAt || review.notes) fail(`draft shadowReviews[${index}] must not contain reviewer evidence`)
        continue
      }
      if (!['approved_pilot', 'rejected'].includes(review.decision)) fail(`shadowReviews[${index}].decision must be approved_pilot or rejected`)
      requiredString(review.reviewerId, `shadowReviews[${index}].reviewerId`)
      validTimestamp(review.reviewedAt, `shadowReviews[${index}].reviewedAt`)
      requiredString(review.evidenceReviewed, `shadowReviews[${index}].evidenceReviewed`)
      requiredString(review.rollbackTarget, `shadowReviews[${index}].rollbackTarget`)
      requiredString(review.notes, `shadowReviews[${index}].notes`)
    } catch (error) {
      errors.push(error.message)
    }
  }
  const missingShadowRuns = PENDING_SHADOW_RUN_IDS.filter((runId) => !runIds.has(runId))
  for (const runId of missingShadowRuns) errors.push(`missing shadow review worksheet entry: ${runId}`)
  const completeShape = errors.length === 0 && signoffs.length === REQUIRED_SIGNOFF_ROLES.length && shadows.length === PENDING_SHADOW_RUN_IDS.length
  const draftPrepared = mode === 'draft' && completeShape
  const prepared = mode === 'submission' && completeShape
  return {
    status: draftPrepared ? 'draft_prepared' : prepared ? 'prepared_for_human_submission' : 'blocked',
    mode,
    prepared,
    draftPrepared,
    submissionPermitted: prepared,
    signoffs: { required: REQUIRED_SIGNOFF_ROLES.length, supplied: signoffs.length, rolesPresent: [...roles], missingRoles: REQUIRED_SIGNOFF_ROLES.filter((role) => !roles.has(role)) },
    shadowReviews: { required: PENDING_SHADOW_RUN_IDS.length, supplied: shadows.length, runIdsPresent: [...runIds], missingRunIds: missingShadowRuns },
    errors,
    submissionPerformed: false,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    authority: 'human_evidence_worksheet_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const worksheetPath = process.argv[2] || process.env.HUMAN_EVIDENCE_WORKSHEET_FILE
    if (!worksheetPath) throw new Error('worksheet path or HUMAN_EVIDENCE_WORKSHEET_FILE is required')
    assertRegularNonSymlinkFile(worksheetPath)
    const result = validateHumanEvidenceWorksheet({ content: fs.readFileSync(worksheetPath, 'utf8') })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.prepared || result.draftPrepared ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      authority: 'human_evidence_worksheet_only',
      prepared: false,
      draftPrepared: false,
      submissionPermitted: false,
      submissionPerformed: false,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
    process.exitCode = 1
  }
}
