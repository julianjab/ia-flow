// Engine-owned ports: persistence/registry contracts consumed exclusively by
// AgentOrchestrator/TaskDispatcher. Moved here as part of the composable-engine
// refactor (docs/prd/composable-engine-refactor.md, Phase 3). Concrete
// implementations (SQLite repos, in-memory registries) stay in apps/server and
// are injected at the composition root (apps/server/src/composition/container.ts).

import type { IAgentProvider, ProviderKind } from '@ia-flow/ai-providers'
import type {
  ExecutionLog,
  ExecutionLogFilters,
  McpCatalogEntry,
  ProjectConfig,
  RepoMapping,
  RepoWorkflow,
  SlackMemberRef,
  SlackReviewMessage,
} from '@ia-flow/shared'

export interface IBroadcast {
  send(msg: object): void
}

export interface IExecutionLogRepository {
  insert(log: ExecutionLog): void
  update(id: string, patch: Partial<ExecutionLog>): void
  list(filters: ExecutionLogFilters): ExecutionLog[]
  /** In-flight rows (finished_at IS NULL). Most recent first. */
  listActive(): ExecutionLog[]
  getById(id: string): ExecutionLog | null
  /**
   * Close every row whose `finished_at` is still null — used at boot to
   * recover from a crash or restart mid-run. Returns the rows as they look
   * AFTER the rewrite, so callers can log a heads-up and (see
   * CompositeExecutionLogRepository) replay each closure to write-only
   * mirrors that a bulk SQL UPDATE would otherwise never reach.
   */
  sweepOrphaned(reason: string): ExecutionLog[]
  /** Distinct non-null `source` values ever recorded — powers the
   *  "container" filter chip row in the Ejecuciones UI. */
  listDistinctSources(): string[]
  /**
   * Wait for any fire-and-forget write still in flight (the remote forward
   * in RemoteExecutionLogRepository). Only implementations with async
   * writes define it; purely synchronous repos leave it undefined. Call it
   * before exiting the process so a shutdown sweep isn't lost mid-POST.
   */
  flush?(): Promise<void>
}

export interface IMcpCatalogRepository {
  list(): McpCatalogEntry[]
  get(id: string): McpCatalogEntry | null
  upsert(entry: McpCatalogEntry, position: number): void
  deleteById(id: string): void
}

// Read-only aggregate. Writes go through the granular per-domain endpoints
// (agents-crud, system-prompts, statuses, projects PATCH).
//
// scope semantics (mirror the db-layer helpers):
//   undefined → default project (back-compat single-tenant callers)
//   string    → that specific project — runtime overlay (project + globals)
//   null      → global rows only (project_id IS NULL); statuses are empty
//               since they always belong to a project
export interface IProjectConfigRepository {
  getConfig(scope?: string | null): Promise<ProjectConfig>
}

export interface IProviderRegistry {
  register(provider: IAgentProvider): void
  get(id: string): IAgentProvider
  list(): IAgentProvider[]
}

// A repo row as it lives in SQLite. `projectId` is required — every repo
// belongs to exactly one project since migration 011.
export interface DbRepoEntry {
  name: string
  projectId: string
  path?: string
  githubOwner?: string
  githubRepo?: string
  workflow?: RepoWorkflow
  description?: string
  /** Canal donde se pide review de los PRs de este repo, y a quién taguear.
   *  Los dos caen a `project.settings` cuando el repo no los define — ver
   *  `resolveSlackReviewTarget` en @ia-flow/shared. */
  slackReviewChannel?: string
  slackReviewers?: SlackMemberRef[]
  /** Los dos textos del pedido. Cada uno cae por separado a
   *  `project.settings.slackReviewMessage`, y de ahí al default histórico. */
  slackReviewMessage?: SlackReviewMessage
}

export interface IRepoRepository {
  // ─── project-scoped CRUD ───────────────────────────────────────────────
  listByProject(projectId: string): DbRepoEntry[]
  getByProject(name: string, projectId: string): DbRepoEntry | null
  upsert(entry: DbRepoEntry): void
  deleteByProject(name: string, projectId: string): void

  // ─── internal lookups (name-only) ──────────────────────────────────────
  // Used by resolveGithubRepo / getRepoPaths / getRepoWorkflow, which
  // historically took a bare `name`. With repos now scoped per-project this
  // just returns the first matching row (names are unique per project but
  // may repeat across projects). Callers with a projectId should prefer
  // `getByProject`.
  list(): DbRepoEntry[]
  get(name: string): DbRepoEntry | null

  // ─── cross-project lookups (for `/api/repos/lookup`) ──────────────────
  findByGithubRepo(owner: string, repo: string): DbRepoEntry[]
  findByPath(path: string): DbRepoEntry[]

  // ─── legacy provider-config bridge ─────────────────────────────────────
  // Both operate against a single target project. `bulkSet` REPLACES the
  // target project's repos (upsert-only, no delete elsewhere).
  bulkSet(mapping: RepoMapping, projectId: string): void
  toMapping(projectId: string): RepoMapping
}

/**
 * Runtime context for a tool execution. Source-specific fields live under
 * `sourceContext` and are opaque here — adapter-owned tools cast to their
 * known shape.
 */
export interface ToolContext {
  repoPaths: Record<string, string>
  /** Source-provided context (set from ITaskSource.getSourceToolContext). */
  sourceContext?: unknown
  /**
   * Absolute filesystem paths that write/edit/exec tools are allowed to touch.
   * Populated by the anthropic-api provider from `ProviderInput.writePaths`,
   * which in turn is fed by the WorkspaceManager. `undefined` means the tool
   * has no writable zones (read-only run); an empty array is equivalent.
   */
  writePaths?: string[]
}

export interface ITool<TInput = unknown> {
  readonly name: string
  readonly description: string
  readonly input_schema: object
  execute(input: TInput, ctx: ToolContext): Promise<string>
  /**
   * Which provider kinds may see this tool. Defaults to both (`['sync','async']`).
   * Tools that require the sandboxed `ToolContext.writePaths` scope (write,
   * edit, exec) should restrict to `['sync']` — the async terminal providers
   * don't build that scope.
   */
  providerKinds?: ProviderKind[]
  /**
   * When true, the tool is part of the runtime contract every task-scoped
   * agent gets for free (lifecycle: complete_task / fail_task). Internal
   * tools are always exposed regardless of the agent's `tools[]` list.
   */
  internal?: boolean
}

export interface IToolRegistry {
  register(tool: ITool): void
  get(name: string): ITool | undefined
  list(): ITool[]
}

/**
 * Cola de mensajes que entran a un run en curso.
 *
 * Interfaz angosta a propósito: el engine sólo necesita leer lo pendiente de
 * una task y marcarlo entregado. De dónde vino cada mensaje (Slack, la API) y
 * dónde se persiste es asunto del adapter.
 */
export interface RunMessagePort {
  pending(taskId: string): Promise<Array<{ id: string; body: string; author?: string }>>
  markDelivered(ids: string[], runId: string): Promise<void>
}

/**
 * Guarda dónde va un run en vuelo, para que un reinicio no se lleve el trabajo.
 *
 * Es distinto de `PauseCheckpointPort`: aquél cuelga el estado de una ESPERA
 * cuando el run se detuvo a propósito; éste lo persiste **mientras corre**, sin
 * que nadie haya pedido nada. Comparten el formato del estado y nada más — uno
 * escribe una vez al final, el otro pisa una fila en cada vuelta.
 *
 * El `state` es opaco: lo produce el provider (ver `ProviderInput.saveCheckpoint`)
 * y este contrato no modela su forma.
 */
export interface RunCheckpointPort {
  save(input: {
    runId: string
    taskId: string
    agentId?: string
    projectId?: string
    state: unknown
    /** Arrastra el contador de reanudaciones al primer save de un run que
     *  reanuda otro. Sólo cuenta en el INSERT. */
    attempts?: number
  }): Promise<void>
  /** Lo que dejó el último run de esta task, si no llegó a cerrar. */
  getByTask(taskId: string): Promise<{
    runId: string
    agentId?: string
    state: unknown
    attempts: number
    updatedAt: string
  } | null>
  /** Un run que terminó no tiene estado que conservar. También se llama sobre
   *  la fila vieja cuando otro run la reanuda. */
  delete(runId: string): Promise<void>
}

/**
 * Cuelga el checkpoint de la espera que la tool `pause_until` ya armó.
 *
 * Son dos pasos y no uno porque el checkpoint no existe cuando la tool corre:
 * lo produce el loop al cortar, una vuelta después. La tool arma la espera
 * (así queda persistida aunque el proceso muera en el medio) y el engine le
 * agrega el estado cuando lo tiene.
 */
export interface PauseCheckpointPort {
  attachCheckpoint(
    taskId: string,
    checkpoint: { messages: unknown[]; reason?: string },
  ): Promise<void>
}
