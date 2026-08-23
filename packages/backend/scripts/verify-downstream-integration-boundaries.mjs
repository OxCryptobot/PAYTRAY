import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = path.resolve(process.env.DOWNSTREAM_INTEGRATION_REPOSITORY_PATH ?? path.resolve(scriptDirectory, '../../..'))
const outputPath = process.env.DOWNSTREAM_INTEGRATION_BOUNDARY_OUTPUT_PATH ?? process.argv[2] ?? '/tmp/paytray-downstream-integration-boundary.json'
const safety = {
  releaseEligible: false,
  settlementAuthority: false,
  mutation: 'read_only',
  deploymentPerformed: false,
  settlementMutationPerformed: false
}
const errors = []
const checks = {}

function addError(check, reason) {
  errors.push({ check, reason })
}

function readText(relativePath) {
  const absolutePath = path.join(repositoryDirectory, relativePath)
  if (!existsSync(absolutePath)) {
    addError(relativePath, 'required source file is missing')
    return ''
  }
  try {
    return readFileSync(absolutePath, 'utf8')
  } catch (error) {
    addError(relativePath, `source file could not be read: ${error.message}`)
    return ''
  }
}

function checkMarkers(name, relativePath, markers) {
  const content = readText(relativePath)
  const markerPresence = Object.fromEntries(markers.map((marker) => [marker, content.includes(marker)]))
  const valid = Object.values(markerPresence).every(Boolean)
  checks[name] = { source: relativePath, markerPresence, valid }
  for (const [marker, present] of Object.entries(markerPresence)) {
    if (!present) addError(name, `required marker is missing: ${marker}`)
  }
}

function checkPackageScripts() {
  const relativePath = 'package.json'
  const content = readText(relativePath)
  if (!content) return
  let packageJson
  try {
    packageJson = JSON.parse(content)
  } catch (error) {
    addError('packageScripts', `package.json is not valid JSON: ${error.message}`)
    return
  }
  const scripts = packageJson.scripts ?? {}
  const expected = {
    'client:e2e:smoke': 'node packages/client/smoke-test.mjs',
    'backend:ready:postgres:check': 'node packages/backend/scripts/verify-ready-postgres-contracts.mjs'
  }
  const values = Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, scripts[name] === value]))
  checks.packageScripts = { source: relativePath, markerPresence: values, valid: Object.values(values).every(Boolean) }
  for (const [name, present] of Object.entries(values)) {
    if (!present) addError('packageScripts', `${name} must equal the expected downstream contract command`)
  }
}

checkPackageScripts()
checkMarkers('clientSmoke', 'packages/client/smoke-test.mjs', [
  'CLIENT_SMOKE_PORT',
  "server.listen(Number.isInteger(requestedPort) ? requestedPort : 0, '127.0.0.1'",
  'fetch(`${baseUrl}${route}`)',
  'portIsolation: requestedPort === 0',
  'PayTray — Work in motion. Money in motion.',
  'Base Sepolia',
  'settlementAuthority: false',
  'mutation: \'read_only\'',
  'server.close'
])
checkMarkers('clientSmokeTests', 'packages/backend/tests/api.test.js', [
  'keeps collaboration health available when payment dependencies are degraded',
  '/api/v2/collaboration/health',
  'fails closed when an operator requests audit, payment-state, or outbox evidence without a database',
  '/api/v2/ops/outbox/health',
  '/api/v2/ops/webhook-inbox/health',
  'Database service error'
])
checkMarkers('outboxProcessorTests', 'packages/backend/tests/outboxProcessor.test.js', [
  'plans a dry run without claiming or mutating events',
  'dryRun: true',
  'mutation: \'read_only\'',
  'outbox_delivery_only',
  'x-paytray-signature',
  'must not be delivered as raw content',
  'SET last_error',
  'processed_no_subscriber'
])
checkMarkers('webhookReplayLoadTests', 'packages/backend/tests/webhookReplayLoad.test.js', [
  'const eventCount = 100',
  'processDurableOutbox',
  'verifyWebhookSignature',
  'WebhookReplayGuard',
  'expect(captured).toHaveLength(eventCount)',
  'expect(replayFailures).toHaveLength(eventCount)',
  'expect(replayFailures.every(Boolean)).toBe(true)'
])
checkMarkers('readyPostgresVerifier', 'packages/backend/scripts/verify-ready-postgres-contracts.mjs', [
  'READY_POSTGRES_DATABASE_ISOLATED',
  'engagementPaymentState',
  'extensionOpenApi',
  'extensionRegistration',
  'webhookInbox',
  'outboxDryRun',
  'releaseEligible: false',
  'settlementMutationPerformed: false'
])
checkMarkers('unitWorkflow', '.github/workflows/paytray-quality.yml', [
  '- name: Run port-isolated client smoke E2E',
  'run: npm run client:e2e:smoke',
  "CLIENT_SMOKE_PORT: '0'",
  '- name: Upload migration audit evidence',
  'DOWNSTREAM_INTEGRATION_BOUNDARY_OUTPUT_PATH=artifacts/downstream-integration-boundary.json',
  'artifacts/downstream-integration-boundary.json',
  'artifacts/downstream-integration-boundary.json.sha256',
  'if-no-files-found: error',
  'retention-days: 7'
])
checkMarkers('postgresWorkflow', '.github/workflows/paytray-quality.yml', [
  'name: Isolated PostgreSQL route contract',
  '- name: Verify ready-PostgreSQL route contracts',
  'run: npm run backend:ready:postgres:check',
  "READY_POSTGRES_DATABASE_ISOLATED: 'true'"
])

const report = {
  status: errors.length === 0 ? 'verified' : 'blocked',
  checks,
  errors,
  authority: 'downstream_integration_boundary_audit_only',
  ...safety,
  valid: errors.length === 0
}
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`)
console[report.valid ? 'log' : 'error'](JSON.stringify(report, null, 2))
if (!report.valid) process.exitCode = 1
