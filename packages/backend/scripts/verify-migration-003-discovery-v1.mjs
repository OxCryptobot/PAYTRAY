#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MIGRATION_DIR = path.resolve(__dirname, '../migrations')
const MIGRATION = '003_discovery_v1'
const DATABASE_URL = process.env.DATABASE_URL || ''
const ISOLATED = process.env.MIGRATION_003_CONTRACT_ISOLATED === 'true'

function json(value) { return JSON.stringify(value, null, 2) }

function assertDisposableDatabaseUrl(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL') }
  const hostAllowed = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
  const databaseAllowed = /(ci|test|disposable|recovery)/i.test(parsed.pathname.replace(/^\//, ''))
  if (!hostAllowed || !databaseAllowed) throw new Error('migration-003 verifier refuses a non-disposable database URL')
}

async function withTransaction(pool, callback) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
    throw error
  } finally { client.release() }
}

async function runMigrations(client) {
  const ready = await client.query(`
    SELECT (
      (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name IN ('availability_status', 'timezone', 'languages', 'verification_status', 'evidence_links', 'response_latency_seconds', 'completion_rate', 'repeat_booking_rate', 'paid_minutes', 'disputes_count')) = 10
      AND (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'profiles' AND indexname IN ('profiles_expertise_gin_idx', 'profiles_languages_gin_idx', 'profiles_discovery_idx', 'profiles_outcome_idx')) = 4
    ) AS ready
  `)
  if (ready.rows[0]?.ready) return
  const files = (await readdir(MIGRATION_DIR)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort()
  for (const file of files) await client.query(await readFile(path.join(MIGRATION_DIR, file), 'utf8'))
}

async function expectSqlState(pool, label, expected, operation) {
  try {
    await withTransaction(pool, operation)
    throw new Error(`${label}: expected PostgreSQL SQLSTATE ${expected}`)
  } catch (error) {
    if (error.message === `${label}: expected PostgreSQL SQLSTATE ${expected}`) throw error
    assert.equal(error.code, expected, `${label}: unexpected SQLSTATE or assertion failure`)
    return { status: 'passed', sqlState: error.code }
  }
}

async function verifyCatalog(client) {
  const expectedColumns = ['availability_status', 'timezone', 'languages', 'verification_status', 'evidence_links', 'response_latency_seconds', 'completion_rate', 'repeat_booking_rate', 'paid_minutes', 'disputes_count']
  const columns = await client.query(`
    SELECT column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = ANY($1::text[])
     ORDER BY ordinal_position
  `, [expectedColumns])
  assert.deepEqual(columns.rows.map((row) => row.column_name), expectedColumns)
  const byName = new Map(columns.rows.map((row) => [row.column_name, row]))
  for (const name of ['availability_status', 'languages', 'verification_status', 'evidence_links', 'completion_rate', 'repeat_booking_rate', 'paid_minutes', 'disputes_count']) assert.equal(byName.get(name).is_nullable, 'NO')
  assert.equal(byName.get('timezone').is_nullable, 'YES')
  assert.equal(byName.get('response_latency_seconds').is_nullable, 'YES')
  assert.equal(byName.get('languages').data_type, 'ARRAY')
  assert.equal(byName.get('languages').udt_name, '_text')
  assert.match(byName.get('availability_status').column_default, /unknown/)
  assert.match(byName.get('languages').column_default, /\{\}/)
  assert.match(byName.get('verification_status').column_default, /unverified/)
  assert.match(byName.get('evidence_links').column_default, /\[\]/)
  for (const name of ['completion_rate', 'repeat_booking_rate', 'paid_minutes', 'disputes_count']) assert.match(byName.get(name).column_default, /0/)

  const indexes = await client.query(`
    SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'profiles'
       AND indexname = ANY($1::text[])
     ORDER BY indexname
  `, [['profiles_discovery_idx', 'profiles_expertise_gin_idx', 'profiles_languages_gin_idx', 'profiles_outcome_idx']])
  assert.deepEqual(indexes.rows.map((row) => row.indexname), ['profiles_discovery_idx', 'profiles_expertise_gin_idx', 'profiles_languages_gin_idx', 'profiles_outcome_idx'])

  return { status: 'passed', columns: expectedColumns.length, indexes: indexes.rows.map((row) => row.indexname), uniquenessBoundary: 'none_defined_by_migration' }
}

async function createFixture(client, prefix) {
  const user = await client.query(`INSERT INTO users (wallet_address, wallet_type) VALUES ($1, 'injected') RETURNING id`, [`${prefix}-user`])
  const profile = await client.query(`INSERT INTO profiles (user_id, name, is_expert, expertise) VALUES ($1, 'Migration 003 verifier', true, ARRAY['engineering']) RETURNING id`, [user.rows[0].id])
  return { userId: user.rows[0].id, profileId: profile.rows[0].id }
}

async function updateProfile(client, fixture, overrides = {}) {
  const values = {
    availabilityStatus: 'available',
    timezone: 'UTC',
    languages: ['en', 'es'],
    verificationStatus: 'verified',
    evidenceLinks: JSON.stringify([{ kind: 'verifier', ref: 'migration-003' }]),
    responseLatencySeconds: 30,
    completionRate: '0.95000',
    repeatBookingRate: '0.80000',
    paidMinutes: 120,
    disputesCount: 0
  }
  Object.assign(values, overrides)
  return client.query(`
    UPDATE profiles
       SET availability_status = $2,
           timezone = $3,
           languages = $4::text[],
           verification_status = $5,
           evidence_links = $6::jsonb,
           response_latency_seconds = $7,
           completion_rate = $8,
           repeat_booking_rate = $9,
           paid_minutes = $10,
           disputes_count = $11,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING availability_status, timezone, languages, verification_status, evidence_links, response_latency_seconds, completion_rate, repeat_booking_rate, paid_minutes, disputes_count
  `, [fixture.profileId, values.availabilityStatus, values.timezone, values.languages, values.verificationStatus, values.evidenceLinks, values.responseLatencySeconds, values.completionRate, values.repeatBookingRate, values.paidMinutes, values.disputesCount])
}

async function runContractSuite(pool) {
  const prefixes = []
  try {
    const catalog = await withTransaction(pool, (client) => verifyCatalog(client))
    const prefix = `migration-003-${Date.now()}-${Math.random().toString(16).slice(2)}`
    prefixes.push(prefix)
    const fixture = await withTransaction(pool, (client) => createFixture(client, prefix))

    const defaults = await pool.query(`
      SELECT availability_status, timezone, languages, verification_status, evidence_links, response_latency_seconds, completion_rate, repeat_booking_rate, paid_minutes, disputes_count
        FROM profiles WHERE id = $1
    `, [fixture.profileId])
    assert.deepEqual(defaults.rows[0], { availability_status: 'unknown', timezone: null, languages: [], verification_status: 'unverified', evidence_links: [], response_latency_seconds: null, completion_rate: '0.00000', repeat_booking_rate: '0.00000', paid_minutes: 0, disputes_count: 0 })

    const roundTrip = await withTransaction(pool, (client) => updateProfile(client, fixture))
    assert.deepEqual(roundTrip.rows[0].languages, ['en', 'es'])
    assert.deepEqual(roundTrip.rows[0].evidence_links, [{ kind: 'verifier', ref: 'migration-003' }])
    assert.equal(roundTrip.rows[0].availability_status, 'available')
    assert.equal(roundTrip.rows[0].verification_status, 'verified')

    const nullAvailability = await expectSqlState(pool, 'null availability status', '23502', (client) => updateProfile(client, fixture, { availabilityStatus: null }))
    const nullLanguages = await expectSqlState(pool, 'null profile languages', '23502', (client) => updateProfile(client, fixture, { languages: null }))
    const nullVerification = await expectSqlState(pool, 'null verification status', '23502', (client) => updateProfile(client, fixture, { verificationStatus: null }))
    const nullEvidenceLinks = await expectSqlState(pool, 'null evidence links', '23502', (client) => updateProfile(client, fixture, { evidenceLinks: null }))
    const nullCompletionRate = await expectSqlState(pool, 'null completion rate', '23502', (client) => updateProfile(client, fixture, { completionRate: null }))
    const nullRepeatBookingRate = await expectSqlState(pool, 'null repeat booking rate', '23502', (client) => updateProfile(client, fixture, { repeatBookingRate: null }))
    const nullPaidMinutes = await expectSqlState(pool, 'null paid minutes', '23502', (client) => updateProfile(client, fixture, { paidMinutes: null }))
    const nullDisputesCount = await expectSqlState(pool, 'null disputes count', '23502', (client) => updateProfile(client, fixture, { disputesCount: null }))

    return {
      status: 'verified',
      cases: {
        catalog,
        defaults: { status: 'passed' },
        roundTrip: { status: 'passed', verifiedStatus: 'verified', languages: ['en', 'es'] },
        nullAvailability,
        nullLanguages,
        nullVerification,
        nullEvidenceLinks,
        nullCompletionRate,
        nullRepeatBookingRate,
        nullPaidMinutes,
        nullDisputesCount,
        concurrencyBoundary: { status: 'not_applicable', reason: 'migration-003 defines no unique or state-transition constraint' }
      },
      cleanupRows: { profiles: 'all profiles for verifier users', users: 'all verifier users' }
    }
  } finally {
    for (const prefix of prefixes) {
      await withTransaction(pool, async (client) => {
        await client.query('DELETE FROM users WHERE wallet_address LIKE $1', [`${prefix}%`])
      })
    }
  }
}

async function main() {
  if (!ISOLATED) {
    console.error(json({ status: 'blocked', reason: 'MIGRATION_003_CONTRACT_ISOLATED=true is required', migration: MIGRATION, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
    return
  }
  assertDisposableDatabaseUrl(DATABASE_URL)
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4, min: 0, connectionTimeoutMillis: 5000 })
  let cleanupPerformed = false
  try {
    await withTransaction(pool, (client) => runMigrations(client))
    const report = await runContractSuite(pool)
    cleanupPerformed = true
    console.log(json({ ...report, migration: MIGRATION, databaseIsolation: true, cleanupPerformed, releaseEligible: false, settlementAuthority: false, mutation: 'read_only', deploymentPerformed: false, settlementMutationPerformed: false }))
  } catch (error) {
    console.error(json({ status: 'blocked', reason: error.message, code: error.code || null, migration: MIGRATION, databaseIsolation: true, cleanupPerformed, releaseEligible: false, settlementAuthority: false, mutation: 'read_only' }))
    process.exitCode = 1
  } finally { await pool.end() }
}

await main()
