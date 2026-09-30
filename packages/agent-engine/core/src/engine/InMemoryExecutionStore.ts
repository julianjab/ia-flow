import type { ExecutionGroups } from './ExecutionScheduler.js'
import { ExecutionStore } from './ExecutionStore.js'
import { InMemoryExecutionRepository } from './InMemoryExecutionRepository.js'

export interface InMemoryExecutionStoreOptions {
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number
  /** Topes por grupo de tasks (ver `ExecutionStoreOptions.groups`). */
  groups?: ExecutionGroups
  /** Ver `ExecutionStoreOptions.newId`. */
  newId?: () => string
}

/** Store en memoria: alcanza para un proceso. Un reinicio pierde todo — también las pausas. */
export class InMemoryExecutionStore extends ExecutionStore {
  constructor(options: InMemoryExecutionStoreOptions = {}) {
    super({ ...options, repository: new InMemoryExecutionRepository() })
  }
}
