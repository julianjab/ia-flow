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
   * recover from a crash or restart mid-run. Returns the number of rows
   * that were rewritten so callers can log a heads-up.
   */
  sweepOrphaned(reason: string): number
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
  /**
   * Returns the markdown appendix that async providers append to the agent's
   * prompt so the model can call each available tool via `curl`. Sync
   * providers get an empty string — they expose tools natively via the API.
   */
  buildToolInstructions(
    toolNames: string[] | undefined,
    provider: Pick<IAgentProvider, 'id' | 'kind'>,
    daemonUrl: string,
    taskId: string,
  ): string
}
