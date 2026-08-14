import { describe, expect, it } from 'vitest'
import { listMigrations, runMigrations } from '../lib/migrations.js'

describe('Paytray database migrations', () => {
  it('discovers ordered SQL migration files', async () => {
    await expect(listMigrations()).resolves.toEqual([
      '001_init.sql',
      '002_financial_core.sql',
      '003_discovery_v1.sql',
      '004_engagement_context.sql',
      '005_outcomes_and_metrics.sql',
      '006_ai_evaluation_foundation.sql',
      '007_discovery_impressions.sql',
      '008_production_telemetry.sql',
      '009_verified_outcome_provenance.sql',
      '010_ledger_intent_idempotency.sql',
      '011_payment_stream_verifier_provenance.sql',
      '012_shadow_run_review.sql',
      '013_verifier_cursors.sql'
    ])
  })

  it('preserves the legacy migration-name convention and applies only missing migrations', async () => {
    const calls = []
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params })
        if (sql.includes('SELECT migration_name')) {
          return { rows: [{ migration_name: '001_init' }] }
        }
        return { rows: [] }
      }
    }

    const executed = await runMigrations(client)

    expect(executed).toEqual(['002_financial_core', '003_discovery_v1', '004_engagement_context', '005_outcomes_and_metrics', '006_ai_evaluation_foundation', '007_discovery_impressions', '008_production_telemetry', '009_verified_outcome_provenance', '010_ledger_intent_idempotency', '011_payment_stream_verifier_provenance', '012_shadow_run_review', '013_verifier_cursors'])
    const inserts = calls.filter((call) => call.sql.includes('INSERT INTO schema_migrations'))
    expect(inserts).toHaveLength(12)
    expect(inserts[0].params).toEqual(['002_financial_core'])
    expect(calls.some((call) => call.sql.includes('CREATE TABLE IF NOT EXISTS payment_intents'))).toBe(true)
  })
})
