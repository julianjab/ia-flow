/**
 * Monta el runner a partir de `.config/`, sin transformar nada:
 *
 *   1. Los servicios: identidad de GitHub (verificada ANTES de montar nada), MCP con `${VAR}`
 *      resuelto y cada servidor probado, el workspace y el provider `anthropic-api`.
 *   2. Las actions de cada scope (`actions/loader.ts`): las globales de `.config/actions/` y las de
 *      cada `projects/<id>/actions/`.
 *   3. Las fuentes: la global (`.config`: sus `pipelines/` y `agents/`) y una por proyecto, que
 *      sólo recibe los eventos de su `scope.projectId` (`ProjectSource`).
 *   4. El engine con `createEngineFromYaml(runner.yaml, { section: 'engine' })`: el store de
 *      ejecuciones en SQLite (`bun-sqlite`), el tick y el clasificador de los `whenText`.
 *
 * En `--dry-run` no hay credenciales: no se verifica GitHub, no se resuelve MCP, no hay workspace
 * y las ejecuciones van a memoria — sólo se construye y valida la definición.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type Engine,
  type EventBus,
  type ExecutionStore,
  InMemoryExecutionStore,
  isAgent,
  type McpServerRef,
  type Pipeline,
  type PipelineSource,
  providerRegistry,
  type ResolvedRoutes,
  type TextClassifier,
} from '@ia-tools/agent-engine'
import {
  createEngineFromYaml,
  type ExecutionStoreDriver,
  YamlPipelineSource,
} from '@ia-tools/agent-engine-yaml'
import { GithubClient } from '@ia-tools/github-api'
import type { GithubAuth } from '@ia-tools/github-auth'
import { parseAnthropicAgentConfig } from '@ia-tools/provider-anthropic'
import { NodeShellRunner, type WorkspaceLogger, WorkspaceManager } from '@ia-tools/workspace'
import type { RunnerServices } from './actions/defineAction.js'
import { GLOBAL_SOURCE, loadActions } from './actions/loader.js'
import type { ProjectConfig, RunnerConfig } from './config/RunnerConfig.js'
import { resolveGithubAuth, verifyGithubAuth } from './github/githubAuth.js'
import { simulatedWritesFetch } from './github/simulatedWrites.js'
import { resolveMcpCatalog } from './mcp/mcpCatalog.js'
import { ProjectSource } from './projects/ProjectSource.js'
import { bunSqliteStoreDriver } from './storage/bunSqliteStoreDriver.js'

/** El clasificador de `--dry-run`: no llama a ningún modelo, y lo dice en la traza. */
const ASSUME_YES: TextClassifier = {
  classify: async () => ({ matches: true, reason: 'dry-run: se asume que sí' }),
}

/** El de `opts`; en `--dry-run` sin uno, `ASSUME_YES`; si no, el de `runner.yaml`. */
function whenTextClassifier(opts: MountOptions): { textClassifier?: TextClassifier } {
  const classifier = opts.textClassifier ?? (opts.dryRun ? ASSUME_YES : undefined)
  return classifier ? { textClassifier: classifier } : {}
}

/** Donde viven los clones y worktrees si no se pasa `WORKSPACE_DIR`. */
const DEFAULT_WORKSPACE_ROOT = join(homedir(), '.cache', 'ia-flow', 'runner-v2', 'workspaces')

export interface MountOptions {
  /** Sin credenciales: no verifica GitHub ni resuelve MCP — sólo construye y valida. */
  dryRun: boolean
  /** Escrituras reales a GitHub; sin esto, se simulan. */
  live: boolean
  workspaceDir?: string
  log: (line: string) => void
  /** Lo que responde la API de GitHub en vez de GitHub, con un token de prueba (tests). */
  githubFetch?: typeof fetch
  /** Quién evalúa los `whenText`, en vez del de `runner.yaml` (tests). En `--dry-run` sin esto,
   *  uno que asume que sí: sin credenciales, la vista previa muestra qué correría. */
  textClassifier?: TextClassifier
}

/** Una fuente montada: la global (`runner`) o la de un proyecto. */
export interface MountedSource {
  id: string
  /** Sus agentes y pipelines, leídos de YAML. */
  yaml: YamlPipelineSource
  /** Lo que ve el engine: la del proyecto, con su filtro por `scope.projectId`. */
  source: PipelineSource
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
  /** GitHub con la identidad del runner (y las escrituras simuladas, sin `--live`). */
  github: GithubClient
  githubAuthMode: string
  mcpServers: string[]
  /** Qué actions registró cada scope. */
  actions: Record<string, string[]>
  missingTools: Set<string>
  warnings: string[]
  /** Deja de escuchar el bus y de vencer pausas, y cierra la base de ejecuciones. */
  stop(): void
}

/** Los logs del `WorkspaceManager` por el log del runner: `[workspace] <mensaje> <contexto>`. */
function workspaceLogger(log: (line: string) => void): WorkspaceLogger {
  const line = (level: string) => (obj: object, msg?: string) =>
    log(`[workspace${level === 'info' ? '' : ` ${level}`}] ${msg ?? ''} ${JSON.stringify(obj)}`)
  return { info: line('info'), debug: () => {}, warn: line('warn'), error: line('error') }
}

/** El `providerConfig` de cada agente de `anthropic-api` tiene la forma de la config del
 *  provider: se valida al montar, para que un typo rompa el arranque y no la primera corrida. */
function validateProviderConfigs(pipelines: Pipeline[]): void {
  for (const pipeline of pipelines) {
    for (const step of pipeline.do) {
      if (!isAgent(step) || step.definition.provider !== 'anthropic-api') continue
      try {
        parseAnthropicAgentConfig(step.definition.providerConfig ?? {})
      } catch (err) {
        throw new Error(`agente "${step.id}" (${pipeline.id}): ${(err as Error).message}`)
      }
    }
  }
}

const memoryDriver: ExecutionStoreDriver = ({ maxConcurrent }) =>
  new InMemoryExecutionStore(maxConcurrent !== undefined ? { maxConcurrent } : {})

async function githubIdentity(opts: MountOptions): Promise<{ auth: GithubAuth; mode: string }> {
  if (opts.dryRun) {
    return {
      auth: { getToken: () => Promise.reject(new Error('dry-run: sin GitHub')) },
      mode: 'dry-run',
    }
  }
  const resolved = await resolveGithubAuth()
  await verifyGithubAuth(resolved)
  return { auth: resolved.auth, mode: resolved.mode }
}

export async function mountRunner(cfg: RunnerConfig, opts: MountOptions): Promise<MountedRunner> {
  const warnings: string[] = []
  const { auth, mode: githubAuthMode } = await githubIdentity(opts)
  const github = opts.githubFetch
    ? new GithubClient({ auth: { getToken: async () => 'test' }, fetchImpl: opts.githubFetch })
    : new GithubClient({
        auth,
        fetchImpl: opts.live || opts.dryRun ? undefined : simulatedWritesFetch(opts.log),
      })
  const mcpServers: Record<string, McpServerRef> = opts.dryRun
    ? {}
    : await resolveMcpCatalog(cfg.mcp, auth, warnings)

  // Clones persistentes en `<root>/repos` y un worktree por task en `<root>/worktrees`. En
  // dry-run no hay token para clonar.
  const workspaceRoot = opts.workspaceDir ?? DEFAULT_WORKSPACE_ROOT
  const workspace = opts.dryRun
    ? undefined
    : new WorkspaceManager(new NodeShellRunner(), {
        reposBase: join(workspaceRoot, 'repos'),
        worktreeBase: join(workspaceRoot, 'worktrees'),
        githubToken: () => auth.getToken(),
        // Un PR lo puede pushear otro (un humano, otra máquina): el reviewer tiene que ver el
        // último commit, no el que quedó en el worktree de una corrida anterior.
        syncBranchWithRemote: true,
        log: workspaceLogger(opts.log),
      })

  const services: RunnerServices = {
    github,
    ...(workspace ? { workspace } : {}),
    // Sólo con `--live`: sin él las escrituras a GitHub se simulan, y publicar una branch también.
    ...(opts.live && !opts.dryRun ? { gitCredential: () => auth.getToken() } : {}),
    dryRun: opts.dryRun,
    live: opts.live,
    log: opts.log,
    missingTools: new Set<string>(),
  }
  const actions = await loadActions(cfg.dir, cfg.projects, services)
  const catalogs = { ...actions.catalogs, providers: providerRegistry, mcpServers }

  const global = new YamlPipelineSource({ dir: cfg.dir, id: GLOBAL_SOURCE, catalogs })
  const sources: MountedSource[] = [
    { id: GLOBAL_SOURCE, yaml: global, source: global },
    ...cfg.projects.map((project) => {
      const yaml = new YamlPipelineSource({ dir: project.dir, id: project.id, catalogs })
      return { id: project.id, yaml, source: new ProjectSource(yaml, project.id) }
    }),
  ]

  const mounted = createEngineFromYaml(cfg.runnerPath, {
    section: 'engine',
    catalogs,
    sources: sources.map((entry) => entry.source),
    // En dry-run nada corre: la base de ejecuciones no se abre.
    drivers: { 'bun-sqlite': opts.dryRun ? memoryDriver : bunSqliteStoreDriver },
    ...whenTextClassifier(opts),
  })
  const pipelines = () => sources.flatMap((entry) => entry.yaml.list())
  try {
    validateProviderConfigs(pipelines())
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
      const owner = sources.find((entry) => entry.yaml.list().includes(pipeline))
      return pipeline.routesOf(agentId, owner?.yaml.defaults)
    },
    projects: cfg.projects,
    github,
    githubAuthMode,
    mcpServers: Object.keys(mcpServers),
    actions: actions.registered,
    missingTools: services.missingTools,
    warnings,
    stop: mounted.stop,
  }
}
