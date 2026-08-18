import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const REQUIRED_ROLES = ['release_operator', 'protocol_finance', 'ai_data', 'security']
const SENSITIVE_KEY = /(?:privateKeyPem|publicKeyPem|secretValue|password|authorization|cookie|rawSignature|transcript|recording|audio|video)/i
const TARGETS = new Set(['local_disposable', 'authenticated_target'])

function fail(message) {
  throw new Error(message)
}

function scanSensitiveKeys(value, path = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanSensitiveKeys(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`sensitive key is not allowed at ${path}.${key}`)
    scanSensitiveKeys(child, `${path}.${key}`)
  }
}

export function validateEvidencePath(filePath, { label = 'evidence', target = 'local_disposable', protectedRoot = '/protected/paytray' } = {}) {
  if (!filePath) fail(`${label} file is required`)
  if (!path.isAbsolute(filePath)) fail(`${label} path must be absolute`)
  const resolvedPath = path.resolve(filePath)
  if (target === 'authenticated_target') {
    if (!path.isAbsolute(protectedRoot)) fail('protected evidence root must be absolute')
    const resolvedRoot = path.resolve(protectedRoot)
    const relative = path.relative(resolvedRoot, resolvedPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`${label} path must be inside the protected evidence root`)
    const realPath = fs.realpathSync(resolvedPath)
    const realRoot = fs.realpathSync(resolvedRoot)
    const realRelative = path.relative(realRoot, realPath)
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) fail(`${label} real path escapes the protected evidence root`)
  }
  return resolvedPath
}

function loadJson(filePath, label, options = {}) {
  const resolvedPath = validateEvidencePath(filePath, { label, ...options })
  const raw = fs.readFileSync(resolvedPath, 'utf8')
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    fail(`${label} file is not valid JSON`)
  }
  scanSensitiveKeys(value)
  return { value, sha256: createHash('sha256').update(raw, 'utf8').digest('hex'), filePath }
}

function findBundle(report) {
  if (report?.bundle && typeof report.bundle === 'object') return report.bundle
  return report
}

function summarizeRoleEvidence(summary, label) {
  if (!summary || typeof summary !== 'object') {
    return {
      label,
      required: REQUIRED_ROLES.length,
      requiredRoles: REQUIRED_ROLES,
      supplied: 0,
      valid: 0,
      rolesPresent: [],
      missingRoles: [...REQUIRED_ROLES],
      complete: false
    }
  }
  const requiredRoles = Array.isArray(summary.requiredRoles) && summary.requiredRoles.length > 0
    ? summary.requiredRoles.filter((role) => REQUIRED_ROLES.includes(role))
    : REQUIRED_ROLES
  const rolesPresent = Array.isArray(summary.rolesPresent)
    ? summary.rolesPresent.filter((role) => REQUIRED_ROLES.includes(role))
    : []
  const missingRoles = REQUIRED_ROLES.filter((role) => !rolesPresent.includes(role))
  return {
    label,
    required: REQUIRED_ROLES.length,
    requiredRoles: REQUIRED_ROLES,
    supplied: Number(summary.supplied) || 0,
    valid: Number(summary.valid) || 0,
    rolesPresent,
    missingRoles,
    complete: summary.complete === true && missingRoles.length === 0 && requiredRoles.length === REQUIRED_ROLES.length
  }
}

function summarizeSigningKey({ releaseEvidence, operatorKey, secretManager }) {
  const bundle = findBundle(releaseEvidence)
  const signingKeyEvidence = bundle?.signingKeyEvidence || bundle?.checks?.find?.((check) => check?.name === 'signingKey')?.evidence || {}
  const operator = operatorKey?.value || operatorKey || {}
  const secret = secretManager?.value || secretManager || {}
  const operatorVerified = operator.status === 'verified' && operator.custodyVerified === true && operator.independentVerification === true
  const secretVerified = secret.status === 'verified' && secret.ephemeralInjectionVerified === true && secret.persistedSecret === false
  const releaseEvidenceReady = signingKeyEvidence.ready === true && signingKeyEvidence.present === true && signingKeyEvidence.independentlyVerified === true
  return {
    status: operatorVerified && secretVerified && releaseEvidenceReady ? 'verified' : 'blocked',
    releaseEvidenceReady,
    operatorKeyStatus: operator.status || 'missing',
    operatorCustodyVerified: operator.custodyVerified === true,
    independentVerification: operator.independentVerification === true,
    secretManagerStatus: secret.status || 'missing',
    ephemeralInjectionVerified: secret.ephemeralInjectionVerified === true,
    persistedSecret: secret.persistedSecret === true,
    criteria: 'Ed25519 key pair, expected fingerprint, approved-secret-manager manifest, ephemeral protected injection, privateKeyExported=false, exact release commit, and independent security-role fingerprint attestation must all verify.'
  }
}

export function buildHumanEvidenceCustodyReport({ releaseEvidence, operatorKey, secretManager, sourceHashes = {}, target = 'local_disposable' } = {}) {
  if (!releaseEvidence || typeof releaseEvidence !== 'object') fail('release evidence is required')
  if (!operatorKey || typeof operatorKey !== 'object') fail('operator-key custody evidence is required')
  if (!secretManager || typeof secretManager !== 'object') fail('secret-manager custody evidence is required')
  if (!TARGETS.has(target)) fail(`unsupported human evidence target: ${target}`)
  scanSensitiveKeys(releaseEvidence)
  scanSensitiveKeys(operatorKey)
  scanSensitiveKeys(secretManager)

  const bundle = findBundle(releaseEvidence)
  const signoffs = summarizeRoleEvidence(bundle?.signoffSummary, 'humanSignoffs')
  const attestations = summarizeRoleEvidence(bundle?.reviewerAttestationSummary, 'reviewerAttestations')
  const signingKey = summarizeSigningKey({ releaseEvidence, operatorKey, secretManager })
  const complete = signoffs.complete && attestations.complete && signingKey.status === 'verified'
  const blockers = []
  if (!signoffs.complete) blockers.push({ name: 'humanSignoffs', missingRoles: signoffs.missingRoles })
  if (!attestations.complete) blockers.push({ name: 'reviewerAttestations', missingRoles: attestations.missingRoles })
  if (signingKey.status !== 'verified') blockers.push({ name: 'ed25519Custody', reason: signingKey.criteria })

  return {
    status: complete ? 'verified' : 'blocked',
    target,
    sourceHashes,
    humanSignoffs: signoffs,
    reviewerAttestations: attestations,
    ed25519Custody: signingKey,
    blockers,
    criteriaComplete: true,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false,
    authority: 'human_evidence_and_custody_status_only'
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const target = process.env.HUMAN_EVIDENCE_TARGET || 'local_disposable'
    const protectedRoot = process.env.PAYTRAY_PROTECTED_EVIDENCE_ROOT || '/protected/paytray'
    const pathOptions = { target, protectedRoot }
    const release = loadJson(process.env.HUMAN_EVIDENCE_RELEASE_FILE, 'human evidence release', pathOptions)
    const operator = loadJson(process.env.HUMAN_EVIDENCE_OPERATOR_KEY_FILE, 'operator-key custody', pathOptions)
    const secret = loadJson(process.env.HUMAN_EVIDENCE_SECRET_MANAGER_FILE, 'secret-manager custody', pathOptions)
    const report = buildHumanEvidenceCustodyReport({
      releaseEvidence: release.value,
      operatorKey: operator.value,
      secretManager: secret.value,
      sourceHashes: {
        releaseEvidence: release.sha256,
        operatorKey: operator.sha256,
        secretManager: secret.sha256
      },
      target
    })
    console.log(JSON.stringify(report, null, 2))
    process.exitCode = report.status === 'verified' ? 0 : 1
  } catch (error) {
    console.log(JSON.stringify({
      status: 'blocked',
      reason: error instanceof Error ? error.message : String(error),
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      authority: 'human_evidence_and_custody_status_only'
    }, null, 2))
    process.exitCode = 1
  }
}
