/**
 * Monta el runner a partir de `.config/`, sin transformar nada:
 *
 *   1. Los servicios: identidad de GitHub (verificada ANTES de montar nada), MCP con `${VAR}`
 *      resuelto y cada servidor probado, el workspace y el provider `anthropic-api`.
 *   2. Las actions de cada scope (`actions/loader.ts`): las globales de `.config/actions/` y las de
 *      cada `projects/<id>/actions/`.
 *   3. Las fuentes: el datasource YAML de la global (lo que declara `runner.yaml`) y el de cada
 *      proyecto (lo que declara su `project.yaml`), cuyas pipelines llevan `scope.projectId`
 *      (`projects/withScope.ts`); las arma `DefinitionPipelineSource`, y releen su índice si cambia.
 *   4. El engine, desde `engine:` de runner.yaml (`engine/mountEngine.ts`): el store de
 *      ejecuciones en SQLite (`bun-sqlite`), el tick y el clasificador de los `whenText`.
 */
import {
  type DispatchJournal,
  type Engine,
  type EventBus,
  type ExecutionGroups,
  type ExecutionStore,
  isAgent,
  type McpServerRef,
  type Pipeline,
  providerRegistry,
  type ResolvedRoutes,
  type Runnable,
  type TextClassifier,
} from '@ia-flow/agent-engine'
import { YamlDefinitionSource } from '@ia-flow/agent-engine-datasource-yaml'
import { DefinitionPipelineSource } from '@ia-flow/agent-engine-definitions'
import { GithubClient } from '@ia-flow/github-api'
import type { GithubAuth } from '@ia-flow/github-auth'
import { SlackClient } from '@ia-flow/slack-api'
import type { RunnerServices } from './actions/defineAction.js'
import { GLOBAL_SOURCE, loadActions } from './actions/loader.js'
import { AssistantDesk } from './assistant/AssistantDesk.js'
import type { ProjectConfig, RunnerConfig } from './config/RunnerConfig.js'
import { mountEngine, type StoreDriver } from './engine/mountEngine.js'
import { resolveGithubAuth, verifyGithubAuth } from './github/githubAuth.js'
import { resolveMcpCatalog } from './mcp/mcpCatalog.js'
import type { McpHost } from './mcp/mcpHost.js'
import { withScope } from './projects/withScope.js'
import { agentConfigValidator, validateProviderDefaults } from './providers/providers.js'
import { bunSqliteStoreDriver } from './storage/bunSqliteStoreDriver.js'
import { trackWorking } from './working/workingMarker.js'
import { mountWorkspace } from './workspace/mountWorkspace.js'

export interface MountOptions {
  workspaceDir?: string
  log: (line: string) => void
  /** Quién evalúa los `whenText`, en vez del de `runner.yaml` (tests). */
  textClassifier?: TextClassifier
  /** Dónde queda cada evento despachado (`storage/activityStore.ts`). */
  dispatchJournal?: DispatchJournal
  /** Los MCP que levantó este runner (`mcpHost:`): los `mcp` con `hosted` se prueban contra ellos. */
  mcpHost?: McpHost
  /** Sólo tests: la API de GitHub la contesta `githubFetch` (con un token de prueba), no se
   *  resuelven los MCP y las ejecuciones van a `storeDriver` en vez del driver de runner.yaml. */
  testing?: { githubFetch: typeof fetch; storeDriver: StoreDriver }
}

/** Una fuente montada: la global (`runner`) o la de un proyecto. */
export interface MountedSource {
  id: string
  source: DefinitionPipelineSource
}

export interface MountedRunner {
  /** Ya suscripto a `bus`: lo que publique un paso (un `emit`, `resolve_task`) se despacha. */
  engine: Engine
  bus: EventBus
  executions?: ExecutionStore
  /** La global primero, después una por proyecto (se recargan en caliente). */
  sources: MountedSource[]
  /** Todas las pipelines, como están ahora. */
  pipelines(): Pipeline[]
  /** Las rutas efectivas de un agente de `pipeline`, con los defaults de su fuente (su
   *  `onError`/`report`) — lo que de verdad va a correr. */
  routesOf(pipeline: Pipeline, agentId: string): ResolvedRoutes
  projects: ProjectConfig[]
  /** GitHub con la identidad del runner. */
  github: GithubClient
  githubAuthMode: string
  mcpServers: string[]
  /** Qué actions registró cada scope. */
  actions: Record<string, string[]>
  warnings: string[]
  /** Lo que reciben las actions — y los providers que lo necesitan (el worktree). */
  services: RunnerServices
  /** Deja de escuchar el bus y de vencer pausas, y cierra la base de ejecuciones. */
  stop(): void
}

/** El `providerConfig` de cada agente tiene la forma de la config de su provider: se valida al
 *  montar, para que un typo rompa el arranque y no la primera corrida. */
function validateProviderConfigs(
  pipelines: Pipeline[],
  capabilities: Record<string, Runnable>,
  validatorFor: ReturnType<typeof agentConfigValidator>,
): void {
  const steps = [
    ...pipelines.flatMap((pipeline) => pipeline.do.map((step) => ({ step, where: pipeline.id }))),
    ...Object.entries(capabilities).map(([name, step]) => ({ step, where: `capacidad ${name}` })),
  ]
  for (const { step, where } of steps) {
    if (!isAgent(step)) continue
    // Cada candidato con la config de SU provider: la de anthropic-api no vale en claude-cli.
    for (const candidate of step.candidates) {
      try {
        validatorFor(candidate.id)?.(candidate.config)
      } catch (err) {
        throw new Error(
          `agente "${step.id}" (${where}), provider ${candidate.id}: ${(err as Error).message}`,
        )
      }
    }
  }
}

/** El tope de cada proyecto (`maxConcurrent` de su `project.yaml`): el grupo de una task es su
 *  `projectId`, que viene en la clave de la ejecución (el scope que publica `resolve_task`). */
function projectGroups(projects: ProjectConfig[]): ExecutionGroups {
  const caps = new Map(projects.map((project) => [project.id, project.maxConcurrent]))
  return {
    of: (key) => {
      try {
        const entry = (JSON.parse(key) as Array<[string, unknown]>).find(([k]) => k === 'projectId')
        return typeof entry?.[1] === 'string' ? entry[1] : undefined
      } catch {
        return undefined
      }
    },
    max: (group) => caps.get(group),
  }
}

async function githubIdentity(opts: MountOptions): Promise<{ auth: GithubAuth; mode: string }> {
  if (opts.testing) return { auth: { getToken: async () => 'test' }, mode: 'test' }
  const resolved = await resolveGithubAuth()
  await verifyGithubAuth(resolved)
  return { auth: resolved.auth, mode: resolved.mode }
}

export async function mountRunner(cfg: RunnerConfig, opts: MountOptions): Promise<MountedRunner> {
  const warnings: string[] = []
  const { auth, mode: githubAuthMode } = await githubIdentity(opts)
  const github = new GithubClient({
    auth,
    ...(opts.testing ? { fetchImpl: opts.testing.githubFetch } : {}),
  })
  const mcpServers: Record<string, McpServerRef> = opts.testing
    ? {}
    : await resolveMcpCatalog(cfg.mcp, auth, warnings, (id) => opts.mcpHost?.upstreamOf(id))

  const { workspace, session } = mountWorkspace({
    ...(opts.workspaceDir ? { root: opts.workspaceDir } : {}),
    githubToken: () => auth.getToken(),
    log: opts.log,
  })

  const services: RunnerServices = {
    github,
    workspace,
    session,
    // La credencial de los `git` de red de un `bash_run` con `githubAuth`: el agente publica su rama.
    gitCredential: () => auth.getToken(),
    slack: new SlackClient({ token: () => process.env.SLACK_BOT_TOKEN }),
    slackUsers: cfg.slack.users,
    assistant: new AssistantDesk(),
    log: opts.log,
  }
  const actions = await loadActions(cfg.actions, cfg.projects, services)
  const catalogs = { ...actions.catalogs, providers: providerRegistry, mcpServers }

  const globalSource = new DefinitionPipelineSource(
    new YamlDefinitionSource({ id: GLOBAL_SOURCE, ...cfg.source }),
    catalogs,
  )
  const sources: MountedSource[] = [
    { id: GLOBAL_SOURCE, source: globalSource },
    ...cfg.projects.map((project) => ({
      id: project.id,
      source: new DefinitionPipelineSource(
        withScope(new YamlDefinitionSource({ id: project.id, ...project.source }), {
          projectId: project.id,
        }),
        catalogs,
      ),
    })),
  ]

  const mounted = mountEngine(cfg.engine, {
    baseDir: cfg.dir,
    sources: sources.map((entry) => entry.source),
    drivers: { 'bun-sqlite': opts.testing?.storeDriver ?? bunSqliteStoreDriver },
    groups: projectGroups(cfg.projects),
    // Las de la fuente global, en vivo: editar `sources.capabilities` recarga sin reiniciar.
    capabilities: (name) => globalSource.capabilities[name],
    ...(opts.textClassifier ? { textClassifier: opts.textClassifier } : {}),
    ...(opts.dispatchJournal ? { dispatchJournal: opts.dispatchJournal } : {}),
  })
  // `Working = Yes` en la card mientras su ejecución corre (ver `project.yaml` → workingMarker).
  const stopWorking = mounted.executions
    ? trackWorking(mounted.executions, cfg.projects, github, opts.log)
    : () => {}
  const pipelines = () => sources.flatMap((entry) => entry.source.list())
  try {
    validateProviderDefaults(cfg.providers)
    validateProviderConfigs(
      pipelines(),
      globalSource.capabilities,
      agentConfigValidator(cfg.providers),
    )
  } catch (err) {
    mounted.stop()
    throw err
  }

  return {
    engine: mounted.engine,
    bus: mounted.bus,
    ...(mounted.executions ? { executions: mounted.executions } : {}),
    sources,
    pipelines,
    routesOf: (pipeline, agentId) => {
      const owner = sources.find((entry) => entry.source.list().includes(pipeline))
      return pipeline.routesOf(agentId, owner?.source.defaults)
    },
    projects: cfg.projects,
    github,
    githubAuthMode,
    mcpServers: Object.keys(mcpServers),
    actions: actions.registered,
    warnings,
    services,
    stop: () => {
      stopWorking()
      mounted.stop()
    },
  }
}
