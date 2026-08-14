import pg from 'pg'
import config from './config.js'
import { ExternalServiceError } from './errors.js'
import { runMigrations } from './migrations.js'

const { Pool } = pg

let pool = null
let databaseStatus = 'uninitialized'

export function getDatabaseStatus() {
  if (!config.database.url) {
    return 'unconfigured'
  }

  return databaseStatus
}

export async function initializeDatabase() {
  if (!config.database.url) {
    databaseStatus = 'unconfigured'
    return null
  }

  try {
    databaseStatus = 'connecting'
    pool = new Pool({
      connectionString: config.database.url,
      max: config.database.pool.max,
      min: config.database.pool.min,
      idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
      connectionTimeoutMillis: config.database.pool.connectionTimeoutMillis
    })

    await pool.query('SELECT 1')
    await transaction(async (client) => runMigrations(client))
    databaseStatus = 'ready'
    return pool
  } catch (error) {
    databaseStatus = 'error'
    throw new ExternalServiceError('Database', error.message)
  }
}

export function getPool() {
  if (!pool) {
    throw new Error('Database has not been initialized')
  }

  return pool
}

export async function query(sql, params = []) {
  return getPool().query(sql, params)
}

export async function transaction(callback) {
  const client = await getPool().connect()

  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export function createModel(tableName) {
  return {
    async findById(id) {
      const result = await query(`SELECT * FROM ${tableName} WHERE id = $1`, [id])
      return result.rows[0] || null
    },

    async findAll(filters = {}, limit = 100, offset = 0) {
      const keys = Object.keys(filters)
      const whereClause = keys.length
        ? `WHERE ${keys.map((key, index) => `${key} = $${index + 1}`).join(' AND ')}`
        : ''
      const params = [...Object.values(filters), limit, offset]
      const result = await query(
        `SELECT * FROM ${tableName} ${whereClause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      )
      return result.rows
    },

    async findOne(field, value) {
      const result = await query(`SELECT * FROM ${tableName} WHERE ${field} = $1`, [value])
      return result.rows[0] || null
    },

    async create(data) {
      const keys = Object.keys(data)
      const values = Object.values(data)
      const placeholders = keys.map((_, index) => `$${index + 1}`).join(', ')
      const result = await query(
        `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
        values
      )
      return result.rows[0]
    },

    async update(id, data) {
      const keys = Object.keys(data)
      const values = Object.values(data)
      const setClause = keys.map((key, index) => `${key} = $${index + 1}`).join(', ')
      const result = await query(
        `UPDATE ${tableName} SET ${setClause} WHERE id = $${keys.length + 1} RETURNING *`,
        [...values, id]
      )
      return result.rows[0] || null
    },

    async delete(id) {
      const result = await query(`DELETE FROM ${tableName} WHERE id = $1 RETURNING *`, [id])
      return result.rows[0] || null
    }
  }
}

export async function closeDatabase() {
  if (pool) {
    await pool.end()
    pool = null
  }

  databaseStatus = config.database.url ? 'closed' : 'unconfigured'
}

export default {
  initializeDatabase,
  getDatabaseStatus,
  getPool,
  query,
  transaction,
  createModel,
  closeDatabase
}
