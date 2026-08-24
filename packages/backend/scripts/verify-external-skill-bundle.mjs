import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 512
const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
const INTEGRITY_VERIFIER_TIMEOUT_MS = 2_000
const ALLOWED_TOP_LEVEL = new Set(['SKILL.md', 'references', 'scripts'])
const SECRET_PATTERNS = Object.freeze({
  privateKeyPem: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  githubToken: /\b(?:ghp|github_pat)_[A-Za-z0-9_]+\b/,
  awsAccessKey: /\bAKIA[0-9A-Z]{16}\b/,
  credentialedUrl: /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
  longBearerToken: /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}\b/i
})

function fail(message) {
  throw new Error(message)
}

function requireRegularFile(filePath, label) {
  const stats = fs.lstatSync(filePath)
  if (!stats.isFile() || stats.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`)
  return stats
}

function parseSidecar(sidecarPath, archivePath) {
  const raw = fs.readFileSync(sidecarPath, 'utf8').trim()
  const fields = raw.split(/\s+/)
  if (fields.length < 1 || fields.length > 2 || !/^[a-f0-9]{64}$/.test(fields[0])) fail('SHA-256 sidecar must contain one lowercase 64-character digest and an optional filename')
  if (fields[1]) {
    const reportedName = fields[1].replace(/^\*/, '')
    if (path.basename(reportedName) !== path.basename(archivePath)) fail('SHA-256 sidecar filename does not match the archive basename')
  }
  return fields[0]
}

function listEntries(archivePath) {
  const output = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  const entries = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
  if (entries.length === 0) fail('skill archive contains no entries')
  if (entries.length > MAX_ARCHIVE_ENTRIES) fail(`skill archive contains too many entries: ${entries.length}`)
  const listing = execFileSync('unzip', ['-l', archivePath], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  const totalMatch = listing.match(/^\s*(\d+)\s+\d+\s+files?\s*$/m)
  if (!totalMatch) fail('skill archive listing has no safe total size')
  const uncompressedBytes = Number(totalMatch[1])
  if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes < 0) fail('skill archive uncompressed size is invalid')
  if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) fail(`skill archive uncompressed size exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`)
  const seen = new Set()
  for (const entry of entries) {
    if (seen.has(entry)) fail(`skill archive contains duplicate entry: ${entry}`)
    seen.add(entry)
    if (entry.includes('\\') || entry.startsWith('/') || entry.includes('\0')) fail(`skill archive contains unsafe entry: ${entry}`)
    const parts = entry.split('/').filter(Boolean)
    if (parts.includes('..')) fail(`skill archive contains traversal entry: ${entry}`)
    if (parts[0] && !ALLOWED_TOP_LEVEL.has(parts[0])) fail(`skill archive contains unexpected top-level entry: ${entry}`)
  }
  if (!entries.includes('SKILL.md')) fail('skill archive is missing root SKILL.md')
  if (!entries.some((entry) => entry.startsWith('references/'))) fail('skill archive is missing references/')
  if (!entries.some((entry) => entry.startsWith('scripts/'))) fail('skill archive is missing scripts/')
  return { entries, uncompressedBytes }
}

function scanExtractedText(root) {
  const findings = []
  const scan = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isSymbolicLink()) fail(`extracted skill contains a symlink: ${path.relative(root, target)}`)
      const mode = fs.lstatSync(target).mode
      if ((mode & 0o6000) !== 0 || (mode & 0o022) !== 0) fail(`extracted skill contains unsafe permissions: ${path.relative(root, target)}`)
      if (entry.isDirectory()) {
        scan(target)
        continue
      }
      if (!entry.isFile()) fail(`extracted skill contains a non-regular entry: ${path.relative(root, target)}`)
      const relative = path.relative(root, target)
      const resolved = fs.realpathSync(target)
      if (path.relative(root, resolved).startsWith(`..${path.sep}`)) fail(`extracted skill escapes its root: ${relative}`)
      if (!/\.(?:md|mjs|js|sh|py|json|yaml|yml|txt)$/.test(entry.name) && entry.name !== 'SKILL.md') continue
      const text = fs.readFileSync(target, 'utf8')
      for (const [name, pattern] of Object.entries(SECRET_PATTERNS)) {
        if (pattern.test(text)) findings.push({ type: name, path: relative })
      }
    }
  }
  scan(root)
  if (findings.length > 0) fail(`credential-like material found in extracted skill: ${findings.map(({ type, path: relative }) => `${type}:${relative}`).join(', ')}`)
  return findings
}

function runExtractedIntegrity(extractedRoot) {
  const verifier = path.join(extractedRoot, 'scripts', 'verify-skill-execution-integrity.mjs')
  const integrityOutputPath = path.join(extractedRoot, '.paytray-execution-integrity.json')
  requireRegularFile(verifier, 'extracted execution-integrity verifier')
  const result = spawnSync(process.execPath, [
    '--experimental-permission',
    `--allow-fs-read=${extractedRoot}`,
    `--allow-fs-write=${integrityOutputPath}`,
    verifier,
    extractedRoot,
    integrityOutputPath
  ], {
    encoding: 'utf8',
    env: {},
    maxBuffer: 2 * 1024 * 1024,
    timeout: INTEGRITY_VERIFIER_TIMEOUT_MS
  })
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') fail(`extracted skill integrity verifier timed out after ${INTEGRITY_VERIFIER_TIMEOUT_MS}ms`)
    fail(`extracted skill integrity verifier could not execute: ${result.error.message}`)
  }
  let report
  try {
    report = JSON.parse(result.stdout || '')
  } catch {
    fail(`extracted skill integrity verifier did not return JSON: ${String(result.stderr || '').slice(0, 500)}`)
  }
  if (result.status !== 0 || report.valid !== true || (report.errors || []).length > 0 || (report.warnings || []).length > 0) fail('extracted skill execution-integrity validation failed or emitted warnings')
  return report
}

export function verifyExternalSkillBundle({ archivePath, sidecarPath, outputPath } = {}) {
  if (!archivePath || !sidecarPath) throw new TypeError('archivePath and sidecarPath are required')
  const normalizedArchivePath = path.resolve(archivePath)
  const normalizedSidecarPath = path.resolve(sidecarPath)
  const output = path.resolve(outputPath || process.env.SKILL_BUNDLE_VERIFICATION_OUTPUT || '/tmp/paytray-external-skill-bundle-verification.json')
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-external-skill-'))
  let result
  try {
    const archiveStats = requireRegularFile(normalizedArchivePath, 'skill archive')
    requireRegularFile(normalizedSidecarPath, 'SHA-256 sidecar')
    if (!normalizedArchivePath.endsWith('.skill')) fail('skill archive must use the .skill extension')
    if (archiveStats.size <= 0 || archiveStats.size > MAX_ARCHIVE_BYTES) fail('skill archive size is outside the permitted bounds')
    const expectedSha256 = parseSidecar(normalizedSidecarPath, normalizedArchivePath)
    const actualSha256 = crypto.createHash('sha256').update(fs.readFileSync(normalizedArchivePath)).digest('hex')
    if (actualSha256 !== expectedSha256) fail(`SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`)
    const { entries, uncompressedBytes } = listEntries(normalizedArchivePath)
    const extractedRoot = path.join(tempRoot, 'extracted')
    fs.mkdirSync(extractedRoot)
    const unzip = spawnSync('unzip', ['-q', normalizedArchivePath, '-d', extractedRoot], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
    if (unzip.status !== 0) fail(`safe extraction failed: ${String(unzip.stderr || '').slice(0, 500)}`)
    const sensitiveFindings = scanExtractedText(extractedRoot)
    const integrity = runExtractedIntegrity(extractedRoot)
    result = {
      status: 'verified',
      reportKind: 'external_skill_bundle_verification',
      archivePath: normalizedArchivePath,
      sidecarPath: normalizedSidecarPath,
      actualSha256,
      expectedSha256,
      sha256Matches: true,
      archiveEntryCount: entries.length,
      archiveUncompressedBytes: uncompressedBytes,
      hasSkillMd: entries.includes('SKILL.md'),
      hasReferences: entries.some((entry) => entry.startsWith('references/')),
      hasScripts: entries.some((entry) => entry.startsWith('scripts/')),
      extractedIntegrity: {
        valid: integrity.valid,
        errors: integrity.errors?.length ?? 0,
        warnings: integrity.warnings?.length ?? 0,
        lineCount: integrity.lineCount,
        workflowStepCount: integrity.workflowStepCount
      },
      sensitiveFindings,
      dependencyScan: {
        status: 'consumer_repository_scope',
        note: 'The .skill archive is resource-only; audit consumer dependencies separately.'
      },
      authority: 'external_skill_bundle_integrity_only',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      errors: []
    }
  } catch (error) {
    result = {
      status: 'blocked',
      reportKind: 'external_skill_bundle_verification',
      error: error instanceof Error ? error.message : String(error),
      authority: 'external_skill_bundle_integrity_only',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      errors: [error instanceof Error ? error.message : String(error)]
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [archivePath, sidecarPath, outputPath] = process.argv.slice(2)
  const result = verifyExternalSkillBundle({ archivePath, sidecarPath, outputPath })
  console.log(JSON.stringify(result, null, 2))
  if (result.status !== 'verified') process.exitCode = 1
}
