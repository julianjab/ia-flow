/**
 * El driver `bun-sqlite` de `engine.yaml`: las ejecuciones en un archivo SQLite con `bun:sqlite`.
 * El repositorio (`@ia-tools/agent-pipeline-sqlite`) no depende del runtime: recibe la base abierta.
 * Así una pausa (esperar el CI) sobrevive a un reinicio del runner.
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExecutionStore } from '@ia-tools/agent-pipeline'
import { SqliteExecutionStore } from '@ia-tools/agent-pipeline-sqlite'

export function bunSqliteStoreDriver(options: {
  path?: string
  maxConcurrent?: number
}): ExecutionStore {
  if (!options.path) {
    throw new Error('executions.path: el driver bun-sqlite necesita el archivo de la base')
  }
  const memory = options.path === ':memory:'
  if (!memory) mkdirSync(dirname(options.path), { recursive: true })
  const database = new Database(options.path, { create: true })
  if (!memory) database.exec('PRAGMA journal_mode = WAL')
  return new SqliteExecutionStore({
    database,
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
  })
}
