import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildEvidenceFingerprint } from '../lib/evidenceFingerprint.js'

const WORKSPACE_PATHS = ['packages/backend', 'packages/sdk']
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta']

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
}

async function loadJson(filePath, label) {
  let raw
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`)
  }
  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
}

function dependencyEntries(manifest) {
  return Object.fromEntries(DEPENDENCY_SECTIONS
    .filter((section) => manifest[section] && typeof manifest[section] === 'object')
    .flatMap((section) => Object.entries(manifest[section]).map(([name, value]) => [`${section}:${name}`, { section, name, range: value }])))
}

function packageEntry(lockfile, workspacePath, name) {
  return lockfile.packages[`${workspacePath}/node_modules/${name}`] || lockfile.packages[`node_modules/${name}`] || null
}

function compareWorkspace({ workspacePath, manifest, lockfile }) {
  const issues = []
  const lockEntry = lockfile.packages[workspacePath]
  if (!lockEntry) {
    issues.push(`${workspacePath} is missing from package-lock.json packages`)
    return { workspacePath, issues }
  }
  if (lockEntry.name !== manifest.name) issues.push(`${workspacePath}.name differs from package-lock.json`)
  if (lockEntry.version !== manifest.version) issues.push(`${workspacePath}.version differs from package-lock.json`)

  for (const [key, dependency] of Object.entries(dependencyEntries(manifest))) {
    const [section, name] = key.split(':')
    const lockDependencies = lockEntry[section] || {}
    if (JSON.stringify(lockDependencies[name]) !== JSON.stringify(dependency.range)) {
      issues.push(`${workspacePath}.${section}.${name} differs from package-lock.json`)
    }
    if (section !== 'peerDependenciesMeta' && !packageEntry(lockfile, workspacePath, name)) {
      issues.push(`${workspacePath}.${section}.${name} has no resolved package entry`)
    }
  }
  return { workspacePath, issues }
}

export async function validateLockfileDrift({ projectRoot = process.cwd() } = {}) {
  const rootManifest = await loadJson(path.join(projectRoot, 'package.json'), 'package.json')
  const lockfile = await loadJson(path.join(projectRoot, 'package-lock.json'), 'package-lock.json')
  assertObject(lockfile.packages, 'package-lock.json.packages')
  const issues = []
  const rootLock = lockfile.packages['']
  if (!rootLock) issues.push('package-lock.json root package entry is missing')
  if (lockfile.lockfileVersion !== 3) issues.push(`package-lock.json.lockfileVersion must be 3, received ${lockfile.lockfileVersion}`)
  const expectedWorkspaces = Array.isArray(rootManifest.workspaces?.packages) ? rootManifest.workspaces.packages : []
  if (JSON.stringify(expectedWorkspaces) !== JSON.stringify(WORKSPACE_PATHS)) issues.push(`package.json workspaces must equal ${JSON.stringify(WORKSPACE_PATHS)}`)
  if (JSON.stringify(rootLock?.workspaces?.packages || []) !== JSON.stringify(expectedWorkspaces)) issues.push('root workspace declarations differ from package-lock.json')

  const workspaces = []
  for (const workspacePath of WORKSPACE_PATHS) {
    const manifest = await loadJson(path.join(projectRoot, workspacePath, 'package.json'), `${workspacePath}/package.json`)
    const result = compareWorkspace({ workspacePath, manifest, lockfile })
    issues.push(...result.issues)
    workspaces.push({
      workspacePath,
      name: manifest.name,
      version: manifest.version,
      dependencyCount: Object.keys(dependencyEntries(manifest)).length,
      status: result.issues.length === 0 ? 'verified' : 'blocked'
    })
  }

  const content = {
    lockfileVersion: lockfile.lockfileVersion,
    workspacePaths: WORKSPACE_PATHS,
    workspaces,
    issues
  }
  return {
    reportKind: 'lockfile_drift_verification',
    status: issues.length === 0 ? 'verified' : 'blocked',
    driftDetected: issues.length > 0,
    projectRoot: path.basename(path.resolve(projectRoot)),
    fingerprint: buildEvidenceFingerprint({ kind: 'paytray_lockfile_drift_v1', content }),
    ...content,
    releaseEligible: false,
    settlementAuthority: false,
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }
}

export async function main() {
  const report = await validateLockfileDrift({ projectRoot: process.env.LOCKFILE_DRIFT_PROJECT_ROOT || process.cwd() })
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'verified') process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main()
  } catch (error) {
    console.error(JSON.stringify({
      reportKind: 'lockfile_drift_verification',
      status: 'blocked',
      driftDetected: true,
      reason: error.message,
      releaseEligible: false,
      settlementAuthority: false,
      mutation: 'read_only',
      deploymentPerformed: false,
      settlementMutationPerformed: false
    }, null, 2))
    process.exitCode = 1
  }
}
