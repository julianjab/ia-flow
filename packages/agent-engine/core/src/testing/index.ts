/**
 * Suites de contrato para quien implementa un puerto del engine (`ExecutionStore`,
 * `PipelineSource`) fuera de este paquete. Importan `vitest`: sólo se usan desde tests.
 */
export type {
  ExecutionStoreFactory,
  ExecutionStoreFactoryOptions,
} from './executionStoreContract.js'
export { executionStoreContract } from './executionStoreContract.js'
export type { PipelineSourceFactory, PipelineSourceFixture } from './pipelineSourceContract.js'
export { pipelineSourceContract } from './pipelineSourceContract.js'
