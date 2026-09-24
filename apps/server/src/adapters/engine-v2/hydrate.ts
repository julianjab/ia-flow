import {
  Agent,
  type AgentRow,
  Engine,
  EventBus,
  Pipeline,
  type PipelineRow,
  Project,
  type ProjectRow,
  Provider,
  Repo,
} from '@ia-flow/engine-v2'
import { agentRepo, projectRepo, providerRegistry, repoRepo, ruleRepo } from '../../composition/container.js'
import { createLogger } from '../../logger.js'
import { V1ProviderAdapter } from './V1ProviderAdapter.js'

const log = createLogger('engine-v2-hydrate')

/**
 * Puebla los catálogos ESTÁTICOS de engine-v2 (Project/Repo/Agent/Provider)
 * desde la config real de v1. Corre una vez al boot, detrás de
 * `IA_FLOW_ENGINE_V2=1` (ver daemon.ts).
 *
 * Los casts `as unknown as <Row>` son deliberados: `AgentDefinition`/`Rule`/
 * `Project`/`DbRepoEntry` de v1 y los `*Row` de v2 se mapearon campo a campo
 * a mano (ver los commits de `Agent.fromRow`/`Pipeline.fromRow`/etc.), pero
 * son dos schemas Zod evolucionados por separado — no vale la pena mantener
 * un tercer tipo "compatible con los dos" sólo para que TS los una sin cast.
 *
 * `agentRepo.inScope(id)` (no `visibleTo`) a propósito: `visibleTo` ya
 * mergea proyecto + globales, así que llamarlo una vez por proyecto
 * registraría cada agente global N veces y `Agent.register` tira en el
 * segundo intento (rechaza id duplicado). `inScope(null)` trae SÓLO los
 * globales, `inScope(projectId)` SÓLO los del proyecto — sin solapamiento.
 *
 * Limitación conocida: no hay todavía un camino de "recargar cuando cambia
 * la config" — `reloadManagers()` no llama a esto. Editar un agente/regla en
 * la UI no se refleja en engine-v2 hasta el próximo boot.
 */
export function hydrateEngineV2Catalogs(): void {
  Project.reset()
  Repo.reset()
  Agent.reset()
  Provider.reset()

  const projects = projectRepo.list()
  for (const project of projects) {
    Project.register(Project.fromRow(project as unknown as ProjectRow))
  }
  for (const repo of repoRepo.list()) {
    Repo.register(Repo.fromRow(repo))
  }
  for (const row of agentRepo.inScope(null)) {
    Agent.register(Agent.fromRow(row as unknown as AgentRow))
  }
  for (const project of projects) {
    for (const row of agentRepo.inScope(project.id)) {
      Agent.register(Agent.fromRow(row as unknown as AgentRow))
    }
  }
  for (const provider of providerRegistry.list()) {
    Provider.register(new V1ProviderAdapter(provider))
  }

  log.info(
    { projects: projects.length, repos: repoRepo.list().length, providers: providerRegistry.list().length },
    'engine-v2: catálogos hidratados desde config v1',
  )
}

/**
 * Arma el `Engine` de v2 con todas las Pipeline (`ruleRepo.list()`, sin
 * scope — a diferencia de Agent, `Pipeline` no se autoindexa por id en un
 * Catalog estático, vive en el roster de ESTE Engine) y lo arranca. Llamar
 * DESPUÉS de `hydrateEngineV2Catalogs()`: `Pipeline.matches` necesita a
 * `Project`/`Agent` ya resueltos para el `AgentAction` que referencian.
 */
export async function buildEngineV2(): Promise<Engine> {
  const bus = new EventBus()
  const engine = new Engine(bus)
  const rules = await ruleRepo.list()
  for (const rule of rules) {
    engine.register(Pipeline.fromRow(rule as unknown as PipelineRow))
  }
  engine.start()
  log.info({ pipelines: rules.length }, 'engine-v2: Engine armado y arrancado')
  return engine
}
