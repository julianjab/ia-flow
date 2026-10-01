import { type ExecutionGroups, ExecutionStore } from '@ia-flow/agent-engine'
import type { SqliteDatabase } from './SqliteDatabase.js'
import { SqliteExecutionRepository } from './SqliteExecutionRepository.js'

export interface SqliteExecutionStoreOptions {
  /** La base ya abierta por el runtime (`openNodeSqlite` de `./node`, o `bun:sqlite`). */
  database: SqliteDatabase
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number
  /** Topes por grupo de tasks (ej. por proyecto), debajo del global. */
  groups?: ExecutionGroups
}

/**
 * Un `ExecutionStore` sobre SQLite: al construirse recupera lo que la base dejó vivo — las pausadas
 * vuelven a esperar y las que corrían cuando el proceso murió se cierran `interrupted` (ver
 * `ExecutionStore`).
 */
export class SqliteExecutionStore extends ExecutionStore {
  /** El repositorio de la base, para inspeccionarla (`find`) o cerrarla. */
  readonly database: SqliteExecutionRepository

  constructor(options: SqliteExecutionStoreOptions) {
    const repository = new SqliteExecutionRepository({ database: options.database })
    super({
      repository,
      ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
      ...(options.groups ? { groups: options.groups } : {}),
    })
    this.database = repository
  }

  close(): void {
    this.database.close()
  }
}
