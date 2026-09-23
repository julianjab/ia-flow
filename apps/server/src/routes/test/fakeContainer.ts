// Superficie compartida para stubear composition/container.js con
// `mock.module` en tests de rutas que quieren evitar el side-effect de abrir
// una conexión SQLite real (ver comentarios en executions.test.ts y
// project-source.test.ts).
//
// `mock.module` reemplaza el module record de TODO el proceso de test, no
// sólo el archivo que lo llama — dos stubs parciales e independientes del
// MISMO módulo compiten por ese registro, y el que gana la carrera (el orden
// de descubrimiento de archivos de Bun no es el mismo en CI que en local)
// deja sin ciertos exports a cualquier otro archivo que importe el container
// real después, incluido el propio archivo que perdió la carrera. Esto ya
// rompió, en sucesivas corridas de CI: application/provider-config.ts +
// routes/providers.ts (projectRepo/repoRepo/promptRepo/providerRegistry),
// routes/project-source.ts (sourceFactory), y el camino de ejecución de
// tools de routes/mcp.ts vía run-context.ts (repoRepo.list/listByProject,
// promptRepo.deleteProviderConfigBlob).
//
// Por eso cada fake implementa la interfaz COMPLETA del port (no sólo los
// métodos que el consumidor que rompió esta vez usaba) — perseguir
// consumidores uno por uno cada vez que CI encuentra uno nuevo es la misma
// trampa que causó el bug original.
export function fakeContainerBase() {
  return {
    projectRepo: {
      getDefaultId: () => null,
      list: () => [],
      get: () => null,
      upsert: () => {
        throw new Error('fakeContainerBase: projectRepo.upsert not implemented')
      },
      archive: () => {},
      deleteCascade: () => {},
    },
    repoRepo: {
      listByProject: () => [],
      getByProject: () => null,
      upsert: () => {},
      deleteByProject: () => {},
      list: () => [],
      get: () => null,
      findByGithubRepo: () => [],
      findByPath: () => [],
      bulkSet: () => {},
      toMapping: () => ({}),
    },
    promptRepo: {
      getPhasePrompt: () => null,
      setPhasePrompt: () => {},
      getUtilityPrompt: () => null,
      setUtilityPrompt: () => {},
      getProviderConfigBlob: () => null,
      setProviderConfigBlob: () => {},
      deleteProviderConfigBlob: () => {},
    },
    providerRegistry: {
      register: () => {},
      get: () => {
        throw new Error('fakeContainerBase: providerRegistry.get not implemented')
      },
      list: () => [],
    },
    sourceFactory: {
      add: () => {},
      get: () => {
        throw new Error('fakeContainerBase: sourceFactory.get not implemented')
      },
      invalidate: () => {},
      validate: () => {},
      listKinds: () => [],
    },
    executionLogRepo: {
      insert: () => {},
      update: () => {},
      list: () => [],
      listActive: () => [],
      getById: () => null,
      sweepOrphaned: () => [],
      listDistinctSources: () => [],
      listLatestByTask: () => [],
    },
    executionStatsRepo: {
      stats: () => {
        throw new Error('fakeContainerBase: executionStatsRepo.stats not implemented')
      },
      agentDetail: () => null,
    },
    INSTANCE_ID: 'test-instance',
  }
}
