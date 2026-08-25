import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildHumanEvidenceCustodyReport, validateEvidencePath } from '../scripts/verify-human-evidence-custody.mjs'

const roles = ['release_operator', 'protocol_finance', 'ai_data', 'security']
const script = path.resolve(process.cwd(), 'scripts/verify-human-evidence-custody.mjs')

function writeJson(root, name, value) {
  const filePath = path.join(root, name)
  fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 })
  return filePath
}

function runCli(files) {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HUMAN_EVIDENCE_RELEASE_FILE: files.releaseEvidence,
      HUMAN_EVIDENCE_OPERATOR_KEY_FILE: files.operatorKey,
      HUMAN_EVIDENCE_SECRET_MANAGER_FILE: files.secretManager,
      HUMAN_EVIDENCE_TARGET: 'local_disposable'
    }
  })
}

function releaseEvidence(overrides = {}) {
  return {
    bundle: {
      signoffSummary: { requiredRoles: roles, supplied: 4, valid: 4, rolesPresent: roles, complete: true },
      reviewerAttestationSummary: { requiredRoles: roles, supplied: 4, valid: 4, rolesPresent: roles, complete: true },
      signingKeyEvidence: { present: true, independentlyVerified: true, ready: true },
      ...overrides
    }
  }
}

function operatorKey(overrides = {}) {
  return { status: 'verified', custodyVerified: true, independentVerification: true, ...overrides }
}

function secretManager(overrides = {}) {
  return { status: 'verified', ephemeralInjectionVerified: true, persistedSecret: false, ...overrides }
}

describe('human evidence and custody report', () => {
  it('reports complete evidence without granting release authority', () => {
    const result = buildHumanEvidenceCustodyReport({ releaseEvidence: releaseEvidence(), operatorKey: operatorKey(), secretManager: secretManager(), target: 'authenticated_target' })
    expect(result).toMatchObject({ status: 'verified', target: 'authenticated_target', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.blockers).toEqual([])
  })

  it('lists every missing role and custody blocker', () => {
    const result = buildHumanEvidenceCustodyReport({
      releaseEvidence: releaseEvidence({ signoffSummary: { requiredRoles: roles, supplied: 0, valid: 0, rolesPresent: [], complete: false }, reviewerAttestationSummary: { requiredRoles: roles, supplied: 0, valid: 0, rolesPresent: [], complete: false } }),
      operatorKey: operatorKey({ status: 'blocked', custodyVerified: false, independentVerification: false }),
      secretManager: secretManager({ status: 'blocked', ephemeralInjectionVerified: false, persistedSecret: false })
    })
    expect(result.status).toBe('blocked')
    expect(result.humanSignoffs.missingRoles).toEqual(roles)
    expect(result.reviewerAttestations.missingRoles).toEqual(roles)
    expect(result.blockers.map((blocker) => blocker.name)).toEqual(['humanSignoffs', 'reviewerAttestations', 'ed25519Custody'])
  })

  it('rejects sensitive key material in source evidence', () => {
    expect(() => buildHumanEvidenceCustodyReport({ releaseEvidence: { privateKeyPem: 'forbidden' }, operatorKey: operatorKey(), secretManager: secretManager() })).toThrow('sensitive key is not allowed')
  })

  it('rejects unsupported targets and never infers authenticated status', () => {
    expect(() => buildHumanEvidenceCustodyReport({ releaseEvidence: releaseEvidence(), operatorKey: operatorKey(), secretManager: secretManager(), target: 'inferred_target' })).toThrow('unsupported human evidence target')
    const result = buildHumanEvidenceCustodyReport({ releaseEvidence: releaseEvidence(), operatorKey: operatorKey(), secretManager: secretManager() })
    expect(result.target).toBe('local_disposable')
  })

  it('requires absolute paths inside the protected root for authenticated target evidence', () => {
    expect(() => validateEvidencePath('relative/report.json', { target: 'authenticated_target' })).toThrow('must be absolute')
    expect(() => validateEvidencePath('/tmp/report.json', { target: 'authenticated_target', protectedRoot: '/protected/paytray' })).toThrow('inside the protected evidence root')
    expect(validateEvidencePath('/tmp/report.json', { target: 'local_disposable' })).toBe('/tmp/report.json')
  })

  it('rejects a protected-root path that does not exist before reading evidence', () => {
    expect(() => validateEvidencePath('/protected/paytray/missing.json', { target: 'authenticated_target', protectedRoot: '/protected/paytray' })).toThrow()
  })

  it('rejects symlinked and non-regular direct inputs with structured blocked output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-human-evidence-inputs-'))
    try {
      const files = {
        releaseEvidence: writeJson(root, 'release-evidence.json', releaseEvidence()),
        operatorKey: writeJson(root, 'operator-key.json', operatorKey()),
        secretManager: writeJson(root, 'secret-manager.json', secretManager())
      }
      const releaseEvidenceSymlink = path.join(root, 'release-evidence-link.json')
      const operatorKeyDirectory = path.join(root, 'operator-key-directory')
      fs.symlinkSync(files.releaseEvidence, releaseEvidenceSymlink)
      fs.mkdirSync(operatorKeyDirectory)

      const symlinkResult = runCli({ ...files, releaseEvidence: releaseEvidenceSymlink })
      expect(symlinkResult.status).toBe(1)
      expect(JSON.parse(symlinkResult.stdout)).toMatchObject({
        status: 'blocked',
        reason: 'human evidence release must not be a symlink',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'human_evidence_and_custody_status_only'
      })

      const directoryResult = runCli({ ...files, operatorKey: operatorKeyDirectory })
      expect(directoryResult.status).toBe(1)
      expect(JSON.parse(directoryResult.stdout)).toMatchObject({
        status: 'blocked',
        reason: 'operator-key custody must be a regular file',
        releaseEligible: false,
        settlementAuthority: false,
        mutation: 'read_only',
        deploymentPerformed: false,
        settlementMutationPerformed: false,
        authority: 'human_evidence_and_custody_status_only'
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlink that escapes the authenticated protected root', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-evidence-root-'))
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-evidence-outside-'))
    const outsideFile = path.join(outsideRoot, 'release.json')
    const linkedFile = path.join(tempRoot, 'release.json')
    fs.writeFileSync(outsideFile, '{}')
    fs.symlinkSync(outsideFile, linkedFile)
    try {
      expect(() => validateEvidencePath(linkedFile, { target: 'authenticated_target', protectedRoot: tempRoot })).toThrow('real path escapes')
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true })
      fs.rmSync(outsideRoot, { recursive: true, force: true })
    }
  })
})
