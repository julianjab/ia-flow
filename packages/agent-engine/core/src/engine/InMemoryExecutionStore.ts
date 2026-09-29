import { ExecutionStore } from './ExecutionStore.js'
import { InMemoryExecutionRepository } from './InMemoryExecutionRepository.js'

export interface InMemoryExecutionStoreOptions {
  /** Cuántas ejecuciones corren a la vez, entre todas las tasks. Default: sin tope. */
  maxConcurrent?: number
}

/** Store en memoria: alcanza para un proceso. Un reinicio pierde todo — también las pausas. */
export class InMemoryExecutionStore extends ExecutionStore {
  constructor(options: InMemoryExecutionStoreOptions = {}) {
    super({ ...options, repository: new InMemoryExecutionRepository() })
  }
}
