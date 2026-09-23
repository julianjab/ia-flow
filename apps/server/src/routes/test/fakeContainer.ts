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
// rompió application/provider-config.ts + routes/providers.ts (necesitan
// projectRepo/repoRepo/promptRepo/providerRegistry) y routes/project-source.ts
// (necesita sourceFactory) cuando executions.test.ts's stub ganaba.
//
// `fakeContainerBase()` es la unión de lo que necesitan los consumidores
// conocidos de composition/container.js. Cada test la spread-ea y sólo pisa
// los campos que le importan a SU caso — así, gane quien gane la carrera, el
// resto del proceso sigue viendo una superficie completa.
export function fakeContainerBase() {
  return {
    projectRepo: { getDefaultId: () => null, get: () => null, list: () => [] },
    repoRepo: { toMapping: () => ({}), bulkSet: () => {} },
    promptRepo: { getProviderConfigBlob: () => null, setProviderConfigBlob: () => {} },
    providerRegistry: { list: () => [] },
    sourceFactory: { get: () => undefined },
    executionLogRepo: {},
    executionStatsRepo: {},
    INSTANCE_ID: 'test-instance',
  }
}
