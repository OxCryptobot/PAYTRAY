import { closeDatabase, getDatabaseStatus, initializeDatabase, transaction } from '../lib/database.js'
import config from '../lib/config.js'
import { buildVerifierOperationsEvidence } from '../lib/verifierOperationsEvidence.js'

let exitCode = 0
try {
  await initializeDatabase()
  if (getDatabaseStatus() !== 'ready') {
    throw new Error('verifier operations evidence requires a ready PostgreSQL database')
  }
  const evidence = await transaction((client) => buildVerifierOperationsEvidence({ client, config }))
  console.log(JSON.stringify(evidence, null, 2))
  exitCode = evidence.status === 'ready' ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({
    status: 'blocked',
    reason: error.message,
    authority: 'verifier_operations_evidence',
    mutation: 'read_only',
    deploymentPerformed: false,
    settlementMutationPerformed: false
  }, null, 2))
  exitCode = 1
} finally {
  await closeDatabase()
}

process.exitCode = exitCode
