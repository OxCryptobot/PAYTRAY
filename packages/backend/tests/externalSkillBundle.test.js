import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { verifyExternalSkillBundle } from '../scripts/verify-external-skill-bundle.mjs'

function writeSidecar(archivePath, sidecarPath, digest = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex')) {
  fs.writeFileSync(sidecarPath, `${digest}  ${path.basename(archivePath)}\n`)
}

function createSafeBundle(root, integrity = { valid: true, errors: [], warnings: [], lineCount: 1, workflowStepCount: 1 }) {
  const source = path.join(root, 'source')
  fs.mkdirSync(path.join(source, 'references'), { recursive: true })
  fs.mkdirSync(path.join(source, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(source, 'SKILL.md'), '# fixture skill\n')
  fs.writeFileSync(path.join(source, 'references', 'contract.md'), 'contract\n')
  fs.writeFileSync(path.join(source, 'scripts', 'verify-skill-execution-integrity.mjs'), `console.log(JSON.stringify(${JSON.stringify(integrity)}))\n`)
  const archive = path.join(root, 'fixture.skill')
  execFileSync('zip', ['-q', '-9', archive, 'SKILL.md', 'references/contract.md', 'scripts/verify-skill-execution-integrity.mjs'], { cwd: source })
  const sidecar = path.join(root, 'fixture.skill.sha256')
  writeSidecar(archive, sidecar)
  return { archive, sidecar }
}

describe('external skill-bundle verifier', () => {
  let root

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'paytray-skill-bundle-test-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('accepts a valid sidecar-bound archive and preserves read-only authority', () => {
    const { archive, sidecar } = createSafeBundle(root)
    const result = verifyExternalSkillBundle({ archivePath: archive, sidecarPath: sidecar, outputPath: path.join(root, 'result.json') })
    expect(result).toMatchObject({
      status: 'verified',
      sha256Matches: true,
      hasSkillMd: true,
      hasReferences: true,
      hasScripts: true,
      archiveUncompressedBytes: expect.any(Number),
      authority: 'external_skill_bundle_integrity_only',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false,
      errors: []
    })
  })

  it('blocks a sidecar digest mismatch and retains immutable safety fields', () => {
    const { archive, sidecar } = createSafeBundle(root)
    writeSidecar(archive, sidecar, '0'.repeat(64))
    const result = verifyExternalSkillBundle({ archivePath: archive, sidecarPath: sidecar })
    expect(result).toMatchObject({
      status: 'blocked',
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    })
    expect(result.error).toContain('SHA-256 mismatch')
  })

  it('blocks an archive with too many entries before extraction', () => {
    const { archive, sidecar } = createSafeBundle(root)
    const source = path.join(root, 'source')
    const extraEntries = Array.from({ length: 513 }, (_, index) => {
      const relative = path.join('references', `extra-${index}.md`)
      fs.writeFileSync(path.join(source, relative), 'extra\n')
      return relative
    })
    execFileSync('zip', ['-q', '-9', archive, ...extraEntries], { cwd: source })
    writeSidecar(archive, sidecar)
    const result = verifyExternalSkillBundle({ archivePath: archive, sidecarPath: sidecar })
    expect(result).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.error).toContain('too many entries')
  })

  it('blocks a sidecar filename mismatch before trusting the digest', () => {
    const { archive, sidecar } = createSafeBundle(root)
    const digest = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    fs.writeFileSync(sidecar, `${digest}  different.skill\n`)
    const result = verifyExternalSkillBundle({ archivePath: archive, sidecarPath: sidecar })
    expect(result).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.error).toContain('filename does not match')
  })

  it('blocks archives without the .skill extension', () => {
    const { archive, sidecar } = createSafeBundle(root)
    const renamed = path.join(root, 'fixture.zip')
    fs.renameSync(archive, renamed)
    const renamedSidecar = path.join(root, 'fixture.zip.sha256')
    fs.renameSync(sidecar, renamedSidecar)
    writeSidecar(renamed, renamedSidecar)
    const result = verifyExternalSkillBundle({ archivePath: renamed, sidecarPath: renamedSidecar })
    expect(result).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.error).toContain('.skill extension')
  })

  it('blocks extracted integrity warnings even when the verifier says valid', () => {
    const { archive, sidecar } = createSafeBundle(root, { valid: true, errors: [], warnings: ['warning'], lineCount: 1, workflowStepCount: 1 })
    const result = verifyExternalSkillBundle({ archivePath: archive, sidecarPath: sidecar })
    expect(result).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.error).toContain('execution-integrity validation failed or emitted warnings')
  })

  it('blocks traversal entries before extraction', () => {
    const source = path.join(root, 'source')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(root, 'outside.txt'), 'outside\n')
    const archive = path.join(root, 'unsafe.skill')
    execFileSync('zip', ['-q', '-9', archive, '../outside.txt'], { cwd: source })
    const sidecar = path.join(root, 'unsafe.skill.sha256')
    writeSidecar(archive, sidecar)
    const result = verifyExternalSkillBundle({ archivePath: archive, sidecarPath: sidecar })
    expect(result.status).toBe('blocked')
    expect(result.error).toContain('traversal entry')
  })

  it('blocks credential-like material in extracted files', () => {
    const { archive, sidecar } = createSafeBundle(root)
    const injected = path.join(root, 'source', 'references', 'injected.txt')
    fs.writeFileSync(injected, '-----BEGIN PRIVATE KEY-----\nforbidden\n')
    execFileSync('zip', ['-q', '-9', archive, 'references/injected.txt'], { cwd: path.join(root, 'source') })
    writeSidecar(archive, sidecar)
    const result = verifyExternalSkillBundle({ archivePath: archive, sidecarPath: sidecar })
    expect(result).toMatchObject({ status: 'blocked', releaseEligible: false, settlementAuthority: false, mutation: 'read_only' })
    expect(result.error).toContain('credential-like material')
  })
})
