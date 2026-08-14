import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'

const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations')

function isMigrationFile(fileName) {
  return /^\d{3}_[a-z0-9_]+\.sql$/i.test(fileName)
}

export async function listMigrations() {
  const files = await fs.readdir(migrationsDirectory)
  return files.filter(isMigrationFile).sort()
}

export async function runMigrations(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      migration_name VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `)

  const applied = await client.query('SELECT migration_name FROM schema_migrations')
  const appliedNames = new Set(applied.rows.map((row) => row.migration_name))
  const migrations = await listMigrations()
  const executed = []

  for (const migrationName of migrations) {
    const migrationId = migrationName.replace(/\.sql$/i, '')
    if (appliedNames.has(migrationName) || appliedNames.has(migrationId)) continue

    const sql = await fs.readFile(path.join(migrationsDirectory, migrationName), 'utf8')
    await client.query(sql)
    await client.query(
      'INSERT INTO schema_migrations (migration_name) VALUES ($1) ON CONFLICT DO NOTHING',
      [migrationId]
    )
    executed.push(migrationId)
  }

  return executed
}
