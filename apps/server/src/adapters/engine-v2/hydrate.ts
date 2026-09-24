import {
  Agent,
  type AgentRow,
  Engine,
  EventBus,
  Pipeline,
  type PipelineRow,
  type PipelineSource,
  Project,
  type ProjectRow,
  Provider,
  Repo,
  type RepoRow,
} from '@ia-flow/engine-v2'
import { agentRepo, projectRepo, providerRegistry, repoRepo, ruleRepo } from '../../composition/container.js'
import { createLogger } from '../../logger.js'
import { V1ProviderAdapter } from './V1ProviderAdapter.js'

const log = createLogger('engine-v2-hydrate')

/**
 * Conecta `Project`/`Repo`/`Agent` a los repos REALES de v1 — no los hidrata
 * a memoria. `Agent.resolve`/`Project.resolve`/`Repo.resolve` ya no tienen
 * catálogo propio: pegan contra la fuente inyectada en CADA llamada, así que
 * esto se llama UNA VEZ al boot (detrás de `IA_FLOW_ENGINE_V2=1`, ver
 * daemon.ts) y no hace falta releer nada — un agente/regla editado en la UI
 * ya aplica en el próximo dispatch, sin reinicio, porque nunca se copió a
 * ningún lado.
 *
 * `Provider` es la excepción: sigue siendo un catálogo en memoria (ver
 * `Catalog.ts`) porque un provider es una instancia concreta armada por el
 * composition root de v1, no una fila de config que un humano edita en
 * caliente — se registra una sola vez, acá.
 *
 * Los casts `as unknown as <Row>` son deliberados: `AgentDefinition`/
 * `Project`/`DbRepoEntry` de v1 y los `*Row` de v2 se mapearon campo a campo
 * a mano (ver los commits de `Agent.fromRow`/`Pipeline.fromRow`/etc.), pero
 * son dos schemas Zod evolucionados por separado — no vale la pena mantener
 * un tercer tipo "compatible con los dos" sólo para que TS los una sin cast.
 */
export function wireEngineV2Sources(): void {
  Project.setSource({
    get: (id) => (projectRepo.get(id) as unknown as ProjectRow) ?? undefined,
  })

  Repo.setSource({
    get: (projectId, name) => (repoRepo.getByProject(name, projectId) as unknown as RepoRow) ?? undefined,
  })

  // `visibleTo(projectId)` ya mergea proyecto + globales (con el proyecto
  // shadowing en colisión de id) — una sola llamada. Sin `projectId` (un
  // evento sin scope) sólo se ven los globales, fail-closed, mismo criterio
  // que v1 aplica a un evento sin `scope.projectId`.
  Agent.setSource({
    get: (id, projectId) => {
      const rows = projectId != null ? agentRepo.visibleTo(projectId) : agentRepo.inScope(null)
      const row = rows.find((r) => r.id === id)
      return row == null ? undefined : (row as unknown as AgentRow)
    },
  })

  for (const provider of providerRegistry.list()) {
    Provider.register(new V1ProviderAdapter(provider))
  }

  log.info({ providers: providerRegistry.list().length }, 'engine-v2: fuentes conectadas a los repos de v1')
}

/**
 * Arma el `Engine` de v2 con un `PipelineSource` que lee `ruleRepo.list()`
 * EN CADA dispatch — sin caché, mismo criterio que `Project`/`Repo`/`Agent`.
 * Llamar DESPUÉS de `wireEngineV2Sources()`: `Pipeline.matches` necesita que
 * `Project`/`Agent` ya resuelvan contra algo para el `AgentAction` que
 * referencian.
 */
export function buildEngineV2(): Engine {
  const bus = new EventBus()
  const pipelineSource: PipelineSource = {
    list: async () => (await ruleRepo.list()).map((row) => Pipeline.fromRow(row as unknown as PipelineRow)),
  }
  const engine = new Engine(bus, pipelineSource)
  engine.start()
  log.info('engine-v2: Engine armado y arrancado')
  return engine
}
