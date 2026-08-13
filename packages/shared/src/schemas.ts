import { z } from 'zod'

// ─── Acceptance Criteria ──────────────────────────────────────────────────────

export const AcceptanceCriterionSchema = z.object({
  given: z.string(),
  when: z.string(),
  then: z.string(),
})

// ─── User Stories ─────────────────────────────────────────────────────────────

export const UserStorySchema = z.object({
  as_a: z.string(),
  i_want: z.string(),
  so_that: z.string(),
  acceptance_criteria: z.array(AcceptanceCriterionSchema),
})

// ─── Impacted Repo ────────────────────────────────────────────────────────────

export const ImpactedRepoSchema = z.object({
  repo: z.string(),
  rationale: z.string(),
  estimated_effort: z.enum(['low', 'medium', 'high']),
})

// ─── Functional PRD ───────────────────────────────────────────────────────────

export const FunctionalPRDSchema = z.object({
  problem_statement: z.string(),
  user_stories: z.array(UserStorySchema),
  out_of_scope: z.array(z.string()),
  open_questions: z.array(z.string()),
  impacted_repos: z.array(ImpactedRepoSchema),
})

// ─── Technical PRD (per repo) ─────────────────────────────────────────────────

export const FileToModifySchema = z.object({
  path: z.string(),
  change_type: z.enum(['create', 'modify', 'delete']),
  description: z.string(),
})

export const ApiContractSchema = z.object({
  endpoint: z.string(),
  method: z.string(),
  request_schema: z.record(z.unknown()),
  response_schema: z.record(z.unknown()),
})

export const TestScenarioSchema = z.object({
  scenario: z.string(),
  given: z.string(),
  when: z.string(),
  then: z.string(),
})

export const RepoDependencySchema = z.object({
  repo: z.string(),
  what: z.string(),
})

export const TechnicalRepoPRDSchema = z.object({
  repo: z.string(),
  files_to_modify: z.array(FileToModifySchema),
  api_contract: ApiContractSchema.optional(),
  data_model_changes: z.string().optional(),
  test_scenarios: z.array(TestScenarioSchema),
  dependencies: z.array(RepoDependencySchema),
  open_questions: z.array(z.string()),
})

export const TechnicalPRDsSchema = z.record(z.string(), TechnicalRepoPRDSchema)

// How the implementation step should stage changes for this repo:
//   'worktree' — create a git worktree in a sibling directory (safe parallel work)
//   'branch'   — create a new branch in-place on the repo checkout
//   'main'     — commit directly on the default branch (no isolation)
export const RepoWorkflowSchema = z.enum(['worktree', 'branch', 'main'])

// ─── Repo Context (used by agents) ───────────────────────────────────────────

export const RepoContextSchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['golang', 'python', 'ruby', 'frontend', 'mobile', 'agent', 'unknown']),
  workflow: RepoWorkflowSchema.optional(),
  claude_md: z.string().optional(),
  manifest: z.string().optional(), // package.json / go.mod / pyproject.toml content
  directory_tree: z.string().optional(),
})

// ─── Task ─────────────────────────────────────────────────────────────────────

export const TaskStatusSchema = z.enum(['queued', 'refining', 'refined', 'approved'])
export const TaskTypeSchema = z.enum(['functional', 'technical'])

export const TaskCommentSchema = z.object({
  body: z.string(),
  created_at: z.string(),
})

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  type: TaskTypeSchema,
  // Cardinality-based semantics:
  //   []           → task sin refinar; el orchestrator no ejecuta agents que
  //                  requieren cwd (aunque agents API pueden seguir corriendo).
  //   ['X']        → task ejecutable; `X` es el repo primario, resuelve cwd.
  //   ['X','Y',…]  → épica; no ejecutable directamente, debe desglosarse en
  //                  sub-issues single-repo.
  repos: z.array(z.string()),
  // Widened to string: runtime uses GitHub Project column names (e.g. "Done", "Refined")
  // in addition to the legacy enum values. Use TaskStatusSchema to validate the enum subset.
  status: z.string(),
  prd: z.union([FunctionalPRDSchema, TechnicalPRDsSchema]).optional(),
  sections: z.record(z.string(), z.string()).optional(),
  created_at: z.string(),
  approved_at: z.string().optional(),
  error: z.string().optional(),
  agent_working: z.boolean().optional(),
  issueNumber: z.number().optional(),
  issueUrl: z.string().optional(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional(),
  // All source-native custom fields keyed by their upstream name (e.g. the
  // GitHub Project column name). Populated by the source's toIssueItem and
  // propagated by issueItemToTask. Used by `evalCondition` as a fallback
  // lookup so `when: [{ field: "ImpProvider", op: "=", value: "API" }]`
  // resolves against Project fields the Task shape doesn't otherwise expose.
  fields: z.record(z.string(), z.string()).optional(),
  comments: z.array(TaskCommentSchema).optional(),
  // Which ia-flow project this task belongs to. Set by the manager that polled
  // the source (github/local) so the dispatcher can resolve project-scoped
  // statuses and agents. Optional to keep legacy single-tenant callers working.
  projectId: z.string().optional(),
  // Nombre de la branch git canónica para esta task. Fuente de verdad: el
  // Development panel del issue en GitHub (linkedBranches). El adapter la
  // popula si existe; el engine la auto-crea (llamando a Claude para nombrarla)
  // la primera vez que un agente con write tools la necesita. Undefined ⇒
  // fallback `task/<id>` en consumidores (WorkspaceManager, terminal-base, {{task.branch}}).
  branch: z.string().optional(),
})

// ─── Repo Registry Entry ─────────────────────────────────────────────────────

export const RepoEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: RepoContextSchema.shape.type,
  hasGit: z.boolean().optional(),
  workflow: RepoWorkflowSchema.optional(),
})

// ─── Provider Config ─────────────────────────────────────────────────────────

export const StepTypeSchema = z.enum(['refine-functional', 'refine-technical', 'implement'])

// ─── MCP Server Config ──────────────────────────────────────────────────────
// Unified MCP server definition consumed by every provider:
//   - stdio: local process launched by the `claude` CLI (terminal providers only).
//   - http/sse: remote URL, usable by both terminal (via --mcp-config) and API
//     (forwarded via `mcp_servers` request field).
// Shape mirrors the Claude CLI's `.mcpServers` JSON so terminal providers can
// dump it out verbatim.

export const McpStdioServerSchema = z.object({
  type: z.literal('stdio').optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
})

export const McpHttpServerSchema = z.object({
  type: z.enum(['http', 'sse']),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  authorizationToken: z.string().optional(),
})

export const McpServerConfigSchema = z.union([McpStdioServerSchema, McpHttpServerSchema])
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

export const McpServersSchema = z.record(z.string(), McpServerConfigSchema)
export type McpServers = z.infer<typeof McpServersSchema>

export const McpCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  config: McpServerConfigSchema,
})
export type McpCatalogEntry = z.infer<typeof McpCatalogEntrySchema>

export const AnthropicApiSettingsSchema = z.object({
  model: z.string(),
  anthropicVersion: z.string(),
  anthropicBeta: z.array(z.string()),
  systemPrompt: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  thinking: z
    .object({
      type: z.enum(['enabled', 'adaptive']),
      budget_tokens: z.number().optional(),
    })
    .optional(),
  stream: z.boolean().optional(),
  responseLanguage: z.string().optional(),
  maxTokens: z.number().int().positive().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  taskBudgetTokens: z.number().int().min(20000).optional(),
  mcpServers: McpServersSchema.optional(),
})

export const TerminalProviderSettingsSchema = z.object({
  model: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  mcpServers: McpServersSchema.optional(),
})
export type TerminalProviderSettings = z.infer<typeof TerminalProviderSettingsSchema>

export const StepOverrideSchema = AnthropicApiSettingsSchema.partial().extend({
  provider: z.string(),
})

export const StepConfigSchema = z.union([z.string(), StepOverrideSchema])

// Repo mapping entry — resolves a local repo name to its GitHub coordinates.
// Shorthand string form: value is the GitHub repo name (owner stays default).
// Object form: override owner, repo, and/or the full local path.
export const RepoMappingEntrySchema = z.object({
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  path: z.string().optional(),
  workflow: RepoWorkflowSchema.optional(),
  description: z.string().optional(),
})

export const RepoMappingValueSchema = z.union([z.string(), RepoMappingEntrySchema])

// Maps local repo directory name → mapping entry.
export const RepoMappingSchema = z.record(z.string(), RepoMappingValueSchema)

// Lookup response for GET /api/repos/lookup — the projects a repo belongs to.
export const RepoLookupResultSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
})

// A repo definition as it lives in the DB: always bound to a project.
// The web CRUD and the /api/repos router speak in RepoDef; RepoMapping* is
// kept as the legacy provider-config shape only.
export const RepoDefSchema = z.object({
  name: z.string(),
  projectId: z.string(),
  path: z.string().optional(),
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  workflow: RepoWorkflowSchema.optional(),
  description: z.string().optional(),
})

export const ProviderConfigSchema = z.object({
  steps: z.record(StepTypeSchema, StepConfigSchema),
  anthropicApi: AnthropicApiSettingsSchema,
  tmuxClaude: TerminalProviderSettingsSchema.optional(),
  itermClaude: TerminalProviderSettingsSchema.optional(),
  repoMappings: RepoMappingSchema.optional(),
  // Global switch for the Haiku file simplifier in read_file. When false,
  // large files are truncated instead of summarized. Per-agent providerConfig
  // (`fileSimplifierEnabled`) overrides this. Defaults to true.
  fileSimplifierEnabled: z.boolean().optional(),
})

// ─── Project Config (status-based agent state machine) ───────────────────────

export const ProjectSettingsSchema = z.object({
  name: z.string().optional(),
  language: z.string().optional(),
})

// ─── Multi-tenant Project (row in `projects` table) ──────────────────────
// A project is the top-level container that groups statuses (required),
// picks a source provider (github/local/…), and optionally overrides global
// agents / system prompts via `projectId`.

// Provider-agnostic reference to where this project's items live. The `kind`
// is validated at runtime by the matching source implementation in
// apps/server/src/project-sources/*; shared has no opinion on which kinds
// exist so new sources can be added server-side without touching this file.
export const SourceRefSchema = z.object({
  kind: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
})

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  language: z.string().optional(),
  source: SourceRefSchema.optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  archivedAt: z.string().nullable().optional(),
})

export const SystemPromptDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  text: z.string(),
  // null / undefined = global (visible in every project)
  projectId: z.string().nullable().optional(),
})
export type SystemPromptDef = z.infer<typeof SystemPromptDefSchema>

// ─── Per-Agent Provider Config ───────────────────────────────────────────
// Opaque blob owned by whichever provider the agent uses. Shared does NOT
// validate its shape — each provider implementation in
// apps/server/src/providers/* parses this against its own Zod schema when
// it needs to consume the config. Keeping this open lets new providers be
// registered server-side (and rendered via the web provider-form registry)
// without shipping a new @ia-flow/shared version.
export const AgentProviderConfigSchema = z.record(z.string(), z.unknown())

export const AgentVariableValueSchema = z.union([
  z.string(),
  z.object({
    value: z.string(),
    full: z.string().optional(),
    description: z.string().optional(),
  }),
])

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  prompt: z.string(),
  systemPrompts: z.array(z.string()).optional(),
  variables: z.record(z.string(), AgentVariableValueSchema).optional(),
  tools: z.array(z.string()).optional(),
  // Per-agent opt-out list. Names in this array are removed from the tool set
  // before `input.tools` filtering runs, so an agent can hide even a globally
  // registered tool without touching the registry. Wired end-to-end via
  // `ProviderInput.disabledTools` → `getToolDefinitions({ disabledTools })`
  // in the anthropic-api provider, and applied to the HTTP curl appendix in
  // the tmux/iterm terminal providers.
  disabledTools: z.array(z.string()).optional(),
  save_output: z.boolean().optional(),
  providerConfig: AgentProviderConfigSchema.optional(),
  // References to entries in the central MCP catalog (see McpCatalogEntrySchema).
  // Expanded at dispatch time and merged into providerConfig.mcpServers; inline
  // entries take precedence so an agent can override a catalog config locally.
  mcpCatalogIds: z.array(z.string()).optional(),
  // null / undefined = global (visible in every project)
  projectId: z.string().nullable().optional(),
  // Overrides el gate implícito del engine para auto-crear una linked branch
  // en GitHub. Cuando undefined, el engine cae a la derivación default:
  // "necesita branch si tiene write tools". Cuando true, siempre intenta
  // crear branch (útil para agentes que hacen commits vía GitHub MCP sin
  // tener write_file/edit_file locales). Cuando false, nunca crea branch
  // aunque tenga write tools.
  requiresBranch: z.boolean().optional(),
})

export const WhenConditionSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.string().optional(),
  logic: z.enum(['and', 'or']).optional(),
})

export const StatusAgentEntrySchema = z.object({
  agent: z.string(),
  // new: array of conditions with per-entry logic; legacy: flat record (all-AND)
  when: z.union([z.array(WhenConditionSchema), z.record(z.string(), z.string())]).optional(),
  onProcess: z.string().optional(),
  onFinish: z.string().optional(),
  onError: z.string().optional(),
  // Label operations serialized as `$labels:+add,-remove,=replace`. Kept in
  // dedicated fields (instead of piggybacking on `onFinish`) so the existing
  // `$set:` parser stays unchanged and the UI can render labels in its own
  // section per outcome slot.
  onProcessLabels: z.string().optional(),
  onFinishLabels: z.string().optional(),
  onErrorLabels: z.string().optional(),
})

export const StatusConfigSchema = z.object({
  name: z.string(),
  agents: z.array(StatusAgentEntrySchema),
  // Required at the DB layer; optional in the schema so legacy imports
  // (e.g. `ProjectConfig` YAML paste) resolve it from the target project.
  projectId: z.string().optional(),
  // When true, the dispatcher runs agents on this status even if the issue
  // is blocked by unfinished issues. Defaults to false (blocked issues are
  // skipped). Useful for statuses like `Refine` where scoping a blocked
  // issue is still valid work; `Build` typically leaves this false.
  allowBlocked: z.boolean().optional(),
})

// ─── Manager Config (plugin-style issue source registry) ─────────────────────

export const LocalManagerConfigSchema = z.object({
  type: z.literal('local'),
  // Optional — a local manager can be shared across projects, or scoped to one.
  projectId: z.string().optional(),
})
export const GitHubManagerConfigSchema = z.object({
  type: z.literal('github'),
  url: z.string(),
  // Which ia-flow project owns this manager. Set when the config is derived
  // from a `projects` row so items dispatched carry the right projectId.
  projectId: z.string().optional(),
})
export const ManagerConfigSchema = z.discriminatedUnion('type', [
  LocalManagerConfigSchema,
  GitHubManagerConfigSchema,
])

export const ProjectConfigSchema = z.object({
  project: ProjectSettingsSchema.optional(),
  systemPrompts: z.array(SystemPromptDefSchema).optional(),
  agents: z.array(AgentDefinitionSchema).optional(),
  statuses: z.array(StatusConfigSchema).optional(),
  scanRoots: z.array(z.string()).optional(),
  managers: z.array(ManagerConfigSchema).optional(),
})

// ─── Execution Log ─────────────────────────────────────────────────────────

export const OutcomeSchema = z.enum(['success', 'error', 'cancelled', 'truncated'])

// Opaque handle to the OS-level backing of an async run. Both terminal
// providers surface one so the orchestrator can save it, kill it on cancel,
// and watchdog its liveness — without knowing whether the session lives in
// a tmux server or an iTerm2 tab.
export const SessionKindSchema = z.enum(['tmux', 'iterm'])

export const ExecutionLogSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  agentId: z.string(),
  providerId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  outcome: OutcomeSchema.nullable(),
  errorMsg: z.string().nullable(),
  stopReason: z.string().nullable(),
  sessionKind: SessionKindSchema.nullable().optional(),
  sessionId: z.string().nullable().optional(),
})

export const ExecutionLogFiltersSchema = z.object({
  projectId: z.union([z.string(), z.array(z.string())]).optional(),
  taskId: z.string().optional(),
  // Multi-select filters: any of the given values matches. A plain string
  // still works for backwards compat with single-value callers.
  agentId: z.union([z.string(), z.array(z.string())]).optional(),
  providerId: z.union([z.string(), z.array(z.string())]).optional(),
  outcome: z.union([OutcomeSchema, z.array(OutcomeSchema)]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().optional(),
})

export const ExecutionLogArraySchema = z.array(ExecutionLogSchema)

export type ExecutionLog = z.infer<typeof ExecutionLogSchema>
export type ExecutionLogFilters = z.infer<typeof ExecutionLogFiltersSchema>
export type SessionKind = z.infer<typeof SessionKindSchema>

// ─── Server Log (Pino daemon.log NDJSON entries) ──────────────────────────
// Structured log lines read directly from the `daemon.log` file (no DB table).
// `extras` captures any dynamic Pino fields (err.stack, projectId, agentId,
// …) that vary per module and aren't part of the fixed pino base shape.

export const ServerLogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])

export const ServerLogEntrySchema = z.object({
  level: ServerLogLevelSchema,
  time: z.string(), // ISO string (pino isoTime)
  pid: z.number().optional(),
  module: z.string().optional(),
  msg: z.string(),
  // Any extra fields present on the raw NDJSON line that aren't already
  // covered by the fixed properties above.
  extras: z.record(z.string(), z.unknown()).optional(),
})

export const ServerLogSortSchema = z.enum(['asc', 'desc'])
export const ServerLogSortBySchema = z.enum(['time', 'level', 'module', 'msg'])

export const ServerLogFiltersSchema = z.object({
  level: ServerLogLevelSchema.optional(),
  // Multi-select: any of the given modules matches. String is accepted for
  // backwards-compatible single-value queries.
  module: z.union([z.string(), z.array(z.string())]).optional(),
  search: z.string().optional(), // substring match on `msg`
  from: z.string().optional(), // ISO datetime lower bound (inclusive)
  to: z.string().optional(), // ISO datetime upper bound (inclusive)
  limit: z.number().optional(), // default 200, capped at 1000 by the route
  offset: z.number().optional(), // line-based pagination
  sort: ServerLogSortSchema.optional(), // route defaults to 'desc'
  // Which column drives the sort. Defaults to 'time'. Sort happens on
  // the full filtered set before pagination so column re-ordering stays
  // correct across pages.
  sortBy: ServerLogSortBySchema.optional(),
  // Filters entries whose extras.projectId matches. Only orchestrator/
  // provider logs currently carry projectId — infra events without it are
  // dropped when this filter is set.
  projectId: z.string().optional(),
  // Filters entries whose extras.runId matches — the correlation id shared
  // by every log line and the execution_logs row of a single agent run.
  runId: z.string().optional(),
})

export const ServerLogEntryArraySchema = z.array(ServerLogEntrySchema)

export const ServerLogLevelCountsSchema = z.object({
  trace: z.number(),
  debug: z.number(),
  info: z.number(),
  warn: z.number(),
  error: z.number(),
  fatal: z.number(),
})

export const ServerLogModulesSchema = z.array(z.string())

export type ServerLogLevel = z.infer<typeof ServerLogLevelSchema>
export type ServerLogEntry = z.infer<typeof ServerLogEntrySchema>
export type ServerLogFilters = z.infer<typeof ServerLogFiltersSchema>
export type ServerLogSort = z.infer<typeof ServerLogSortSchema>
export type ServerLogSortBy = z.infer<typeof ServerLogSortBySchema>

// ─── Hook Events (terminal hook → server) ─────────────────────────────────
// Payload posted by `hook-tool-use.ts` (now a multi-event forwarder) to
// `POST /api/hook-events`. Covers all Claude Code hook types:
//   PreToolUse   → event: 'tool.pre' (or 'subagent.start' when tool=Task)
//   PostToolUse  → event: 'tool.call' (legacy: event absent = same)
//   UserPromptSubmit → event: 'agent.prompt'
//   Stop         → event: 'agent.stop'
//   SubagentStop → event: 'subagent.stop'
//   SessionStart → event: 'agent.session_start'
//
// `input`  — the tool_input object emitted by Claude Code (opaque shape).
// `result` — stringified tool_response, truncated by the hook at 10 KB.
// `prompt` — user prompt text, truncated to 10 KB.
// `subagentType`, `description` — populated only for `subagent.start`, extracted
// from the `Task` tool_input. `parentToolUseId` is present when Claude Code
// reports a nested tool_use (e.g. tools invoked by a subagent) — lets the UI
// group tool calls under their originating subagent.
export const HookEventSchema = z.object({
  runId: z.string(),
  event: z
    .enum([
      'tool.call',
      'tool.pre',
      'agent.prompt',
      'agent.stop',
      'subagent.start',
      'subagent.stop',
      'agent.session_start',
    ])
    .optional(),
  toolName: z.string().optional(),
  toolUseId: z.string().optional(),
  parentToolUseId: z.string().optional(),
  subagentType: z.string().optional(),
  description: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  result: z.string().optional(),
  prompt: z.string().optional(),
  stopReason: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().optional(),
})
export type HookEvent = z.infer<typeof HookEventSchema>

// Legacy alias kept for backward compat — hook-events.ts was the only consumer
// and it has been updated to use HookEventSchema directly.
export const HookToolEventSchema = HookEventSchema
export type HookToolEvent = HookEvent
