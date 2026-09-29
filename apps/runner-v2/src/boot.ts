/**
 * Monta el runner a partir de `.config/`:
 *
 *   1. Identidad de GitHub (`IA_FLOW_GITHUB_*`), verificada ANTES de montar nada.
 *   2. Catálogo MCP con `${VAR}` resuelto y cada servidor probado.
 *   3. Un board por proyecto (`runner.yaml` → `projects.<id>.board`) y el catálogo de acciones que
 *      nombra la definición (`catalog/buildCatalogs.ts`).
 *   4. El engine con `createEngineFromYaml(.config/engine.yaml)`: los proyectos de
 *      `.config/projects/` (agentes, pipelines y el intake de webhooks, con recarga en caliente) y
 *      las ejecuciones en SQLite (`bun-sqlite`).
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
  providerRegistry,
  type ResolvedRoutes,
  type TextClassifier,
} from '@ia-tools/agent-pipeline'
import { createEngineFromYaml, type ExecutionStoreDriver } from '@ia-tools/agent-pipeline-yaml'
import { GithubClient } from '@ia-tools/github-api'
import type { GithubAuth } from '@ia-tools/github-auth'
import { parseAnthropicAgentConfig } from '@ia-tools/provider-anthropic'
import {
  NodeShellRunner,
  type WorkspaceLogger,
  WorkspaceManager,
  WorkspaceSession,
} from '@ia-tools/workspace'
import { type BoardActions, buildBoardActions, simulatedWritesFetch } from './actions/board.js'
import { buildCatalogs } from './catalog/buildCatalogs.js'
import type { ProjectSettings, RepoDef, RunnerConfig } from './config/RunnerConfig.js'
import { resolveGithubAuth, verifyGithubAuth } from './github/githubAuth.js'
import { GithubTaskReader } from './intake/GithubTaskReader.js'
import { ResolveTaskAction } from './intake/ResolveTaskAction.js'
import { resolveMcpCatalog } from './mcp/mcpCatalog.js'
import { formatEventMessage } from './messages.js'
import { RAW_PREFIX } from './serve.js'
import { bunSqliteStoreDriver } from './storage/bunSqliteStoreDriver.js'
import { workspaceTargetFor } from './workspace.js'

/** El clasificador de `--dry-run`: no llama a ningún modelo, y lo dice en la traza. */
const ASSUME_YES: TextClassifier = {
  classify: async () => ({ matches: true, reason: 'dry-run: se asume que sí' }),
}

/** El de `opts`; en `--dry-run` sin uno, `ASSUME_YES`; si no, el de `engine.yaml`. */
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
  /** Quién evalúa los `whenText`, en vez del de `engine.yaml` (tests). En `--dry-run` sin esto,
   *  uno que asume que sí: sin credenciales, la vista previa muestra qué correría. */
  textClassifier?: TextClassifier
}

/** Un proyecto montado: lo de `runner.yaml` más su board. */
export interface RunnerProject extends ProjectSettings {
  actions: BoardActions
}

export interface MountedRunner {
  /** Ya suscripto a `bus`: lo que publique un paso (un `emit` del intake) se despacha. */
  engine: Engine
  bus: EventBus
  executions?: ExecutionStore
  /** Las pipelines de los proyectos, como están ahora (la definición se recarga en caliente). */
  pipelines(): Pipeline[]
  /** Las de entrada: las que reciben los webhooks crudos (`github.<evento>`). */
  intake(): Pipeline[]
  /** Las rutas efectivas de un agente de `pipeline`, con los defaults de su proyecto (su
   *  `onError`/`report`) — lo que de verdad va a correr. */
  routesOf(pipeline: Pipeline, agentId: string): ResolvedRoutes
  projects: RunnerProject[]
  repos: RepoDef[]
  githubAuthMode: string
  mcpServers: string[]
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

/** El `resolve_task` de un proyecto: su board, su prefijo de rama y su catálogo de repos. */
function resolveTask(project: RunnerProject, reader: GithubTaskReader): ResolveTaskAction {
  return new ResolveTaskAction(
    {
      id: project.id,
      board: project.board,
      branchPrefix: project.branchPrefix,
      ...(project.label ? { label: project.label } : {}),
      repos: project.repos.map((repo) => `${repo.githubOwner}/${repo.githubRepo}`),
      reposText: project.repos
        .map(
          (repo) =>
            `- ${repo.name} (${repo.githubOwner}/${repo.githubRepo}): ${repo.description ?? ''}`,
        )
        .join('\n'),
    },
    reader,
  )
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

export async function mountRunner(cfg: RunnerConfig, opts: MountOptions): Promise<MountedRunner> {
  const warnings: string[] = []

  let auth: GithubAuth
  let githubAuthMode: string
  if (opts.dryRun) {
    auth = { getToken: () => Promise.reject(new Error('dry-run: sin GitHub')) }
    githubAuthMode = 'dry-run'
  } else {
    const resolved = await resolveGithubAuth()
    await verifyGithubAuth(resolved)
    auth = resolved.auth
    githubAuthMode = resolved.mode
  }
  const client = opts.githubFetch
    ? new GithubClient({ auth: { getToken: async () => 'test' }, fetchImpl: opts.githubFetch })
    : new GithubClient({
        auth,
        fetchImpl: opts.live || opts.dryRun ? undefined : simulatedWritesFetch(opts.log),
      })
  const mcpServers: Record<string, McpServerRef> = opts.dryRun
    ? {}
    : await resolveMcpCatalog(cfg.mcp, auth, warnings)

  // Clones persistentes en `<root>/repos` y un worktree por task en `<root>/worktrees` —
  // `fs_*`/`bash_run` corren en el de la corrida. En dry-run no hay token para clonar.
  const workspaceRoot = opts.workspaceDir ?? DEFAULT_WORKSPACE_ROOT
  const workspace = opts.dryRun
    ? undefined
    : new WorkspaceSession(
        new WorkspaceManager(new NodeShellRunner(), {
          reposBase: join(workspaceRoot, 'repos'),
          worktreeBase: join(workspaceRoot, 'worktrees'),
          githubToken: () => auth.getToken(),
          // Un PR lo puede pushear otro (un humano, otra máquina): el reviewer tiene que ver el
          // último commit, no el que quedó en el worktree de una corrida anterior.
          syncBranchWithRemote: true,
          log: workspaceLogger(opts.log),
        }),
        workspaceTargetFor,
      )

  const projects: RunnerProject[] = cfg.projects.map((project) => ({
    ...project,
    actions: buildBoardActions(client, project.board, project.repos),
  }))
  const missingTools = new Set<string>()
  const catalogs = buildCatalogs({
    boards: new Map(projects.map((project) => [project.id, project.actions])),
    providers: providerRegistry,
    mcpServers,
    workspace,
    // Sólo con `--live`: sin él las escrituras a GitHub se simulan, y publicar una branch también.
    gitCredential: opts.live && !opts.dryRun ? () => auth.getToken() : undefined,
    missingTools,
    intake: new Map(
      projects.map((project) => [project.id, resolveTask(project, new GithubTaskReader(client))]),
    ),
  })

  const mounted = createEngineFromYaml(cfg.enginePath, {
    catalogs,
    // En dry-run nada corre: la base de ejecuciones no se abre.
    drivers: { 'bun-sqlite': opts.dryRun ? memoryDriver : bunSqliteStoreDriver },
    formatMessage: formatEventMessage,
    ...whenTextClassifier(opts),
  })
  // El intake son las pipelines que reciben los webhooks crudos (`github.<evento>`).
  const all = () => mounted.sources.flatMap((source) => source.list())
  const isIntake = (pipeline: Pipeline) => pipeline.on.some((type) => type.startsWith(RAW_PREFIX))
  const intake = () => all().filter(isIntake)
  const pipelines = () => all().filter((pipeline) => !isIntake(pipeline))
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
    pipelines,
    routesOf: (pipeline, agentId) => {
      const source = mounted.sources.find((candidate) => candidate.list().includes(pipeline))
      return pipeline.routesOf(agentId, source?.defaults)
    },
    intake,
    projects,
    repos: cfg.repos,
    githubAuthMode,
    mcpServers: Object.keys(mcpServers),
    missingTools,
    warnings,
    stop: mounted.stop,
  }
}
