import fs from 'node:fs'

const EXPECTED_RUN_IDS = [
  'd9280263-932b-45b0-a173-ed3e7e2dcb3c',
  '5d85ded6-4842-4091-85f3-8046e90c7b79',
  'eacb1d9e-99e6-4ad1-a8c2-ab536dfd5f49',
  '3ea9789e-23aa-4dc7-b4ea-5ac9a807b36a',
  'c25b2bee-4fac-4f87-acf3-00541a093030',
  '7b0f934d-8bda-4b10-aa4c-d7fc019078e4'
]
const TERMINAL_DECISIONS = new Set(['approved_pilot', 'rejected'])
const PLACEHOLDER = /<[^>]+>|TODO|TBD|REPLACE_ME|EXAMPLE_ONLY/i
const SENSITIVE_KEY = /(private.?key|secret|password|authorization|cookie|jwt|token|signature|raw.?content|transcript|recording|audio|video)/i
const SUBMISSION_CONFIRMATION = 'I_UNDERSTAND_HUMAN_REVIEW_SUBMISSION'
const APPROVED_PILOT_CONFIRMATION = 'I_UNDERSTAND_APPROVED_PILOT_DECISION'

function fail(message) {
  throw new Error(message)
}

function requiredText(value, field, minimum = 1) {
  if (typeof value !== 'string' || value.trim().length < minimum || PLACEHOLDER.test(value)) {
    fail(`${field} must contain real non-placeholder text of at least ${minimum} characters`)
  }
  return value.trim()
}

function assertSafeTree(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeTree(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive field is not allowed at ${path}.${key}`)
    assertSafeTree(child, `${path}.${key}`)
  }
}

function loadWorksheet(filePath) {
  if (!filePath) fail('PAYTRAY_REVIEW_WORKSHEET_FILE is required')
  const content = fs.readFileSync(filePath, 'utf8')
  let worksheet
  try {
    worksheet = JSON.parse(content)
  } catch {
    fail('review worksheet is not valid JSON')
  }
  assertSafeTree(worksheet)
  if (!worksheet || typeof worksheet !== 'object' || Array.isArray(worksheet)) fail('review worksheet must be an object')
  if (worksheet.releaseCommit && !/^[0-9a-f]{40}$/.test(worksheet.releaseCommit)) fail('releaseCommit must be a lowercase 40-character commit hash')
  if (!Array.isArray(worksheet.reviews) || worksheet.reviews.length !== EXPECTED_RUN_IDS.length) fail('worksheet must contain exactly six reviews')

  const seen = new Set()
  const reviews = worksheet.reviews.map((review, index) => {
    const runId = requiredText(review?.runId, `reviews[${index}].runId`)
    if (!EXPECTED_RUN_IDS.includes(runId)) fail(`reviews[${index}].runId is not one of the six pending shadow runs`)
    if (seen.has(runId)) fail(`duplicate shadow run in worksheet: ${runId}`)
    seen.add(runId)
    if (!TERMINAL_DECISIONS.has(review?.decision)) fail(`reviews[${index}].decision must be approved_pilot or rejected; no decision is generated automatically`)
    const notes = requiredText(review.notes, `reviews[${index}].notes`, 20)
    const evidenceReviewed = requiredText(review.evidenceReviewed, `reviews[${index}].evidenceReviewed`, 20)
    const rollbackTarget = requiredText(review.rollbackTarget, `reviews[${index}].rollbackTarget`, 3)
    return { runId, decision: review.decision, notes, evidenceReviewed, rollbackTarget }
  })
  const missing = EXPECTED_RUN_IDS.filter((runId) => !seen.has(runId))
  if (missing.length) fail(`worksheet is missing run IDs: ${missing.join(', ')}`)
  return { releaseCommit: worksheet.releaseCommit || null, reviews }
}

function requireSubmitGuards(reviews) {
  if (process.env.SHADOW_REVIEW_SUBMISSION_ENABLED !== 'true') {
    fail('SHADOW_REVIEW_SUBMISSION_ENABLED=true is required; default mode is dry-run')
  }
  if (process.env.SHADOW_REVIEW_SUBMISSION_CONFIRMATION !== SUBMISSION_CONFIRMATION) {
    fail(`SHADOW_REVIEW_SUBMISSION_CONFIRMATION must equal ${SUBMISSION_CONFIRMATION}`)
  }
  if (reviews.some((review) => review.decision === 'approved_pilot') && process.env.SHADOW_REVIEW_APPROVED_PILOT_CONFIRMATION !== APPROVED_PILOT_CONFIRMATION) {
    fail(`approved_pilot decisions require SHADOW_REVIEW_APPROVED_PILOT_CONFIRMATION=${APPROVED_PILOT_CONFIRMATION}`)
  }
  const baseUrl = requiredText(process.env.PAYTRAY_REVIEW_BASE_URL, 'PAYTRAY_REVIEW_BASE_URL')
  let parsed
  try {
    parsed = new URL(baseUrl)
  } catch {
    fail('PAYTRAY_REVIEW_BASE_URL must be a valid URL')
  }
  const localHttp = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && localHttp)) fail('PAYTRAY_REVIEW_BASE_URL must use HTTPS unless it targets localhost for controlled testing')
  requiredText(process.env.PAYTRAY_REVIEW_ACCESS_TOKEN, 'PAYTRAY_REVIEW_ACCESS_TOKEN', 20)
  return parsed.toString().replace(/\/$/, '')
}

function dryRunReport({ worksheet, filePath }) {
  return {
    status: 'dry_run',
    worksheetFile: filePath,
    releaseCommit: worksheet.releaseCommit,
    expectedRunCount: EXPECTED_RUN_IDS.length,
    suppliedRunCount: worksheet.reviews.length,
    decisionsReviewed: worksheet.reviews.map(({ runId, decision }) => ({ runId, decision })),
    networkRequestsPerformed: false,
    submissionPerformed: false,
    applied: false,
    promotionStatus: 'shadow_only',
    authority: 'human_review_required',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

async function submitReviews({ worksheet, filePath }) {
  const baseUrl = requireSubmitGuards(worksheet.reviews)
  const results = []
  for (const review of worksheet.reviews) {
    const submissionNotes = [
      review.notes,
      `Evidence reviewed: ${review.evidenceReviewed}`,
      `Rollback target: ${review.rollbackTarget}`
    ].join('\n')
    const response = await fetch(`${baseUrl}/api/v2/ops/shadow-runs/${review.runId}/review`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.PAYTRAY_REVIEW_ACCESS_TOKEN}`
      },
      body: JSON.stringify({ decision: review.decision, notes: submissionNotes })
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) fail(`review submission failed for ${review.runId}: HTTP ${response.status}`)
    if (payload.success !== true || payload.applied !== false || payload.authority !== 'human_review_required' || payload.promotionStatus !== 'shadow_only') {
      fail(`unsafe review response for ${review.runId}: applied/promotion/authority contract was not preserved`)
    }
    results.push({
      runId: review.runId,
      decision: review.decision,
      status: 'verified',
      idempotentReplay: payload.idempotentReplay === true,
      applied: false,
      promotionStatus: 'shadow_only',
      authority: 'human_review_required'
    })
  }
  return {
    status: 'submitted_and_verified',
    worksheetFile: filePath,
    releaseCommit: worksheet.releaseCommit,
    expectedRunCount: EXPECTED_RUN_IDS.length,
    submittedRunCount: results.length,
    results,
    submissionPerformed: true,
    applied: false,
    promotionStatus: 'shadow_only',
    authority: 'human_review_required',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

const filePath = process.env.PAYTRAY_REVIEW_WORKSHEET_FILE
try {
  const worksheet = loadWorksheet(filePath)
  const mode = process.env.SHADOW_REVIEW_SUBMISSION_MODE || 'dry_run'
  const report = mode === 'submit' ? await submitReviews({ worksheet, filePath }) : dryRunReport({ worksheet, filePath })
  console.log(JSON.stringify(report, null, 2))
  process.exitCode = report.status === 'submitted_and_verified' || report.status === 'dry_run' ? 0 : 1
} catch (error) {
  console.log(JSON.stringify({
    status: 'blocked',
    reason: error instanceof Error ? error.message : String(error),
    worksheetFile: filePath || null,
    networkRequestsPerformed: false,
    submissionPerformed: false,
    applied: false,
    promotionStatus: 'shadow_only',
    authority: 'human_review_required',
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  process.exitCode = 1
}
