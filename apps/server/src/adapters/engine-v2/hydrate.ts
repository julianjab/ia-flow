import {
  Agent,
  type AgentRow,
  Engine,
  type EngineSources,
  EventBus,
  Execution,
  ExecutionLog,
  Pipeline,
  type PipelineRow,
  Project,
  type ProjectRow,
  Provider,
  Repo,
  type RepoRow,
} from '@ia-flow/engine-v2'
import {
  agentRepo,
  projectRepo,
  providerRegistry,
  repoRepo,
  ruleRepo,
} from '../../composition/container.js'
import { createLogger } from '../../logger.js'
import { V1ProviderAdapter } from './V1ProviderAdapter.js'

const log = createLogger('engine-v2-hydrate')

/**
 * `Provider` sigue siendo un catálogo en memoria (ver `Catalog.ts`): un
 * provider es una instancia concreta armada por el composition root de v1,
 * no una fila de config que un humano edita en caliente — se registra una
 * sola vez, acá.
 */
export function registerEngineV2Providers(): void {
  for (const provider of providerRegistry.list()) {
    Provider.register(new V1ProviderAdapter(provider))
  }
  log.info({ providers: providerRegistry.list().length }, 'engine-v2: providers registrados')
}

/**
 * Adapters de `EngineSources` sobre los repos REALES de v1 — no hidratan nada
 * a memoria: cada `get`/`list` pega contra el repo en CADA dispatch, así que
 * un agente/regla editado en la UI aplica en el próximo evento, sin reinicio.
 * Cada adapter es dueño de traducir su fila (`*.fromRow`); las entidades de
 * v2 no saben de dónde vienen.
 *
 * Los casts `as unknown as <Row>` son deliberados: `AgentDefinition`/
 * `Project`/`DbRepoEntry` de v1 y los `*Row` de v2 se mapearon campo a campo
 * a mano (ver los commits de `Agent.fromRow`/`Pipeline.fromRow`/etc.), pero
 * son dos schemas Zod evolucionados por separado — no vale la pena mantener
 * un tercer tipo "compatible con los dos" sólo para que TS los una sin cast.
 */
function v1Sources(): EngineSources {
  return {
    pipelines: {
      list: async () =>
        (await ruleRepo.list()).map((row) => Pipeline.fromRow(row as unknown as PipelineRow)),
    },
    projects: {
      get: (id) => {
        const row = projectRepo.get(id)
        return row == null ? undefined : Project.fromRow(row as unknown as ProjectRow)
      },
    },
    repos: {
      get: (projectId, name) => {
        const row = repoRepo.getByProject(name, projectId)
        return row == null ? undefined : Repo.fromRow(row as unknown as RepoRow)
      },
    },
    // `visibleTo(projectId)` ya mergea proyecto + globales (con el proyecto
    // shadowing en colisión de id) — una sola llamada. Sin `projectId` (un
    // evento sin scope) sólo se ven los globales, fail-closed, mismo criterio
    // que v1 aplica a un evento sin `scope.projectId`.
    agents: {
      get: (id, projectId) => {
        const rows = projectId != null ? agentRepo.visibleTo(projectId) : agentRepo.inScope(null)
        const row = rows.find((r) => r.id === id)
        return row == null ? undefined : Agent.fromRow(row as unknown as AgentRow)
      },
    },
    // "executions_logs -> executions": todavía no hay una tabla de v1 para
    // esperas/pausas (v1 tiene `waits`/`run_checkpoints` propias, que no
    // portamos) — la fuente real disponible HOY es el propio `ExecutionLog`
    // de v2, extendido con `waitUntil`/`checkpoint`. Cuando exista una tabla
    // durable de v1 para esto, este adapter cambia, `Engine`/`Execution` no.
    executions: {
      list: async (taskId) =>
        ExecutionLog.byTask(taskId)
          .map((entry) => Execution.fromLog(entry))
          .filter((e): e is Execution => e != null),
      consume: async (id) => {
        ExecutionLog.consume(id)
      },
    },
  }
}

/** Arma y arranca el `Engine` de v2 con sus fuentes inyectadas por constructor. */
export function buildEngineV2(): Engine {
  const engine = new Engine(new EventBus(), v1Sources())
  engine.start()
  log.info('engine-v2: Engine armado y arrancado')
  return engine
}
