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

// De dónde salió un comentario de la conversación de una task.
//
// `pr-review` es distinto de `pr` a propósito: un comentario de la pestaña
// Conversation es una opinión sobre el cambio; uno de review está anclado a un
// archivo y una línea, y trae `path`/`line`/`threadId`. Colapsarlos perdería
// justamente la ubicación, que es la mitad del valor de una review.
export const TaskCommentOriginSchema = z.enum(['issue', 'pr', 'pr-review'])
export type TaskCommentOrigin = z.infer<typeof TaskCommentOriginSchema>

export const TaskCommentSchema = z.object({
  // Optional: only sources that support markCommentsUsed (GitHub) populate
  // it — needed to mark a comment "read" after a run consumes it. Absent for
  // sources without that notion (comments still render fine, just never
  // get deduped across re-dispatches of the same task).
  id: z.string().optional(),
  body: z.string(),
  created_at: z.string(),
  // Ausente ⇒ `issue`. Los sources que no modelan PRs (local-fs) nunca lo
  // pueblan, y el render los trata como comentarios del issue igual que antes.
  origin: TaskCommentOriginSchema.optional(),
  /** Número del PR — sólo en `pr` / `pr-review`. Es lo que el agente necesita
   *  para pedirle el detalle al MCP de GitHub. */
  prNumber: z.number().optional(),
  /** Autor, para distinguir un handoff del pipeline de feedback humano de un
   *  vistazo. El marker `<!-- ia-flow: -->` ya lo dice, pero no se renderiza. */
  author: z.string().optional(),
  /** Sólo `pr-review`: dónde está anclado el comentario en el código. */
  path: z.string().optional(),
  line: z.number().optional(),
  /** Sólo `pr-review`: id del thread, para `reply_pr_review_thread` /
   *  `resolve_pr_review_thread`. Sin esto el agente puede leer la review pero
   *  no contestarla donde fue hecha. */
  threadId: z.string().optional(),
})
export type TaskComment = z.infer<typeof TaskCommentSchema>

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

// ─── Pull Request ────────────────────────────────────────────────────────────

// PR asociado a una task. Cruza la frontera server↔web (los sources lo
// publican en el item, la web lo dibuja), así que vive acá y no duplicado a
// cada lado.
export const PullRequestRefSchema = z.object({
  number: z.number(),
  url: z.string(),
  // Node id de la API v4. Es lo que convierte a este ref en algo accionable
  // por el engine y no sólo dibujable por la web: `addComment(subjectId:)` y la
  // conexión `comments` funcionan igual sobre un PR que sobre un issue, así que
  // con esto comentar en el PR y leerlo es la MISMA llamada con otro id.
  // Opcional porque la web nunca lo necesitó y las filas viejas no lo traen.
  nodeId: z.string().optional(),
  // `merged` no es un state nativo de GitHub (modela un PR cerrado con
  // `merged: true`) — se colapsa acá porque es la distinción que importa.
  state: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  title: z.string().optional(),
  // Branch de origen del PR y su repo/owner: es la rama real del trabajo
  // cuando el issue quedó vinculado por el PR y no por el Development panel.
  headRefName: z.string().optional(),
  headRepo: z.string().optional(),
  headOwner: z.string().optional(),
  // Rollup de los checks del último commit del PR (`statusCheckRollup.state`,
  // lowercase). AUSENTE ≠ `pending`: significa que el PR no tiene ningún check
  // configurado, así que no hay CI que esperar — ver `isCiFinished`.
  ci: z.enum(['success', 'failure', 'error', 'pending', 'expected']).optional(),
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

// ─── Agent Memory ────────────────────────────────────────────────────────────
// Lo único que un agente se lleva de un run al siguiente. Es un KV plano
// namespaceado por `(agentId, projectId)`: el aislamiento entre agentes no es
// una convención de nombres de key, es la identidad de la fila.
//
// `projectId` vacío = memoria GLOBAL del agente (vale en todos los proyectos).
// Es un string y no un `null` opcional porque forma parte de la primary key, y
// en SQLite dos NULL nunca son iguales — una PK con NULL no deduplicaría nada.

/** Tope de la key. Corto a propósito: una key es un identificador, no contenido. */
export const AGENT_MEMORY_KEY_MAX = 256
/** Tope del value, en bytes UTF-8. Un agente que quiere guardar un archivo
 *  quiere el filesystem, no la memoria. */
export const AGENT_MEMORY_VALUE_MAX_BYTES = 64 * 1024

export const AgentMemoryEntrySchema = z.object({
  agentId: z.string().min(1),
  /** '' = global al agente. Ver arriba por qué no es `undefined`. */
  projectId: z.string().default(''),
  key: z.string().min(1).max(AGENT_MEMORY_KEY_MAX),
  value: z.string(),
  /** ISO 8601. Cuándo se escribió por última vez esta key. */
  updatedAt: z.string(),
})
export type AgentMemoryEntry = z.infer<typeof AgentMemoryEntrySchema>

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
  /** Max resends of an unchanged message list when the API pauses a long
   *  server-tool turn (`stop_reason: pause_turn`). See LoopOptions in
   *  packages/tools/src/contract.ts. Default 0 (no retry). */
  maxPauseTurnRetries: z.number().int().min(0).max(20).optional(),
  /** Retry once with more max_tokens when `max_tokens` cuts off a `tool_use`
   *  block mid-JSON. See LoopOptions.retryTruncatedToolUse. Default false. */
  retryTruncatedToolUse: z.boolean().optional(),
  mcpServers: McpServersSchema.optional(),
  /** Tope de runs simultáneos de ESTE provider. Config adicional del
   *  provider, como el resto de este bloque — no una tabla aparte. El engine
   *  lo consume vía `withinDeclaredCap` (packages/ai-providers/src/admission.ts).
   *  `undefined` o `0` = sin límite. */
  maxConcurrentRuns: z.number().int().nonnegative().optional(),
})

export const TerminalProviderSettingsSchema = z.object({
  model: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  mcpServers: McpServersSchema.optional(),
  /** Tope de runs simultáneos de ESTE provider. Config adicional del
   *  provider, como el resto de este bloque — no una tabla aparte. El engine
   *  lo consume vía `withinDeclaredCap` (packages/ai-providers/src/admission.ts).
   *  `undefined` o `0` = sin límite. */
  maxConcurrentRuns: z.number().int().nonnegative().optional(),
  /** Sólo `tmux-claude`: abrir la sesión en iTerm apenas arranca. Por defecto
   *  el run es headless — la sesión de tmux vive en background y se mira con
   *  `tmux attach -t <session>` cuando uno quiere. `iterm-claude` ignora este
   *  flag: abrir un tab ES ese provider. */
  surfaceInTerminal: z.boolean().optional(),
})
export type TerminalProviderSettings = z.infer<typeof TerminalProviderSettingsSchema>

export const StepOverrideSchema = AnthropicApiSettingsSchema.partial().extend({
  provider: z.string(),
})

export const StepConfigSchema = z.union([z.string(), StepOverrideSchema])

// Repo mapping entry — resolves a local repo name to its GitHub coordinates.
// Shorthand string form: value is the GitHub repo name (owner stays default).
// Object form: override owner, repo, and/or the full local path.
// Quién recibe el tag cuando se pide review de un PR de este repo. Es una
// referencia a Slack, no un usuario de ia-flow: `id` es lo único que Slack
// necesita para armar la mención (`<@id>` funciona igual para una persona y
// para un bot), y `name`/`isBot` viajan sólo para que la UI pueda dibujar el
// chip sin pegarle a la API en cada render.
export const SlackMemberRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  isBot: z.boolean().optional(),
})
export type SlackMemberRef = z.infer<typeof SlackMemberRefSchema>

// Los dos textos del pedido de review, redefinibles por repo o por proyecto.
//
// Un objeto y no dos columnas sueltas porque son la MISMA decisión ("cómo
// hablamos cuando pedimos review") en sus dos momentos, y porque así el bag de
// `project.settings` se mergea por una sola key. Cada campo hereda por separado
// — ver `resolveSlackReviewTarget` en ./slack-review.ts.
export const SlackReviewMessageSchema = z.object({
  /** Primer pedido: abre el hilo y linkea el PR. */
  first: z.string().optional(),
  /** Re-review: cae DENTRO del hilo, donde el PR ya está. */
  reReview: z.string().optional(),
})
export type SlackReviewMessage = z.infer<typeof SlackReviewMessageSchema>

export const RepoMappingEntrySchema = z.object({
  githubOwner: z.string().optional(),
  githubRepo: z.string().optional(),
  path: z.string().optional(),
  workflow: RepoWorkflowSchema.optional(),
  description: z.string().optional(),
  // Config del pedido de review en Slack. Vive en el repo porque a quién hay
  // que taguear es una propiedad del código, no de quien pide el review. Los
  // dos caen por separado a `project.settings` — ver `resolveSlackReviewTarget`.
  slackReviewChannel: z.string().optional(),
  slackReviewers: z.array(SlackMemberRefSchema).optional(),
  slackReviewMessage: SlackReviewMessageSchema.optional(),
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
  slackReviewChannel: z.string().optional(),
  slackReviewers: z.array(SlackMemberRefSchema).optional(),
  slackReviewMessage: SlackReviewMessageSchema.optional(),
})

// El límite de un provider, tal como lo consume el engine: indexado por id.
// NO es donde se configura — cada provider declara su `maxConcurrentRuns`
// dentro de sus propios settings (`anthropicApi`, `tmuxClaude`, …), y el
// composition root arma este mapa a partir de ellos. Existe como tipo aparte
// porque `resolveProvider` necesita mirar por id sin saber de qué bloque de
// config salió cada número.
export const ProviderLimitSchema = z.object({
  // `undefined` o `0` = sin límite.
  maxConcurrentRuns: z.number().int().nonnegative().optional(),
})
export type ProviderLimit = z.infer<typeof ProviderLimitSchema>

// Salud de un provider REMOTO (una instancia de apps/agent-host
// registrada acá). No es cosmética: un remoto sólo está registrado en el
// ProviderRegistry —y por lo tanto es elegible por un agente— mientras su
// health sea `ok`. Cuando el agent-host deja de responder, el monitor lo
// desregistra y este objeto es lo único que queda para explicar por qué
// desapareció de la lista de providers.
//
//   ok       el agent-host contestó la última sonda
//   down     no contestó (red caída, 401, 5xx) — no está disponible
//   unknown  todavía no se sondeó (recién booteado)
export const RemoteProviderHealthStatusSchema = z.enum(['ok', 'down', 'unknown'])
export type RemoteProviderHealthStatus = z.infer<typeof RemoteProviderHealthStatusSchema>

export const RemoteProviderHealthSchema = z.object({
  status: RemoteProviderHealthStatusSchema,
  /** ISO — cuándo terminó la última sonda. Ausente si nunca se sondeó. */
  checkedAt: z.string().optional(),
  /** Ida y vuelta de la última sonda, en ms. */
  latencyMs: z.number().nonnegative().optional(),
  /** Motivo del último fallo, para mostrarlo tal cual en la UI. */
  error: z.string().optional(),
  /** Fallos seguidos. Se resetea en el primer `ok`. */
  consecutiveFailures: z.number().int().nonnegative(),
})
export type RemoteProviderHealth = z.infer<typeof RemoteProviderHealthSchema>

export const ProviderConfigSchema = z.object({
  steps: z.record(StepTypeSchema, StepConfigSchema),
  anthropicApi: AnthropicApiSettingsSchema,
  tmuxClaude: TerminalProviderSettingsSchema.optional(),
  itermClaude: TerminalProviderSettingsSchema.optional(),
  repoMappings: RepoMappingSchema.optional(),
})

// Static YAML shape for IGlobalSettingsRepository — a single object (not an
// array like the other Yaml*Repository files) mirroring the `global_settings`
// table's two well-known concerns: raw key/value overrides and scan roots.
export const YamlGlobalSettingsSchema = z.object({
  scanRoots: z.array(z.string()).optional(),
  values: z.record(z.string(), z.string()).optional(),
})

// Static YAML shape for IPromptRepository — a single object bundling the
// three concerns SqlitePromptRepository stores as `global_settings` rows
// under `prompt.<step>` / `util.<key>` / `provider_config`.
export const YamlPromptCatalogSchema = z.object({
  phasePrompts: z.record(StepTypeSchema, z.string()).optional(),
  utilityPrompts: z.record(z.string(), z.string()).optional(),
  providerConfig: ProviderConfigSchema.optional(),
})

// ─── Project Config (status-based agent state machine) ───────────────────────

// Un elemento de `systemPrompts[]` (en AgentDefinition y en
// ProjectSettings): o un id que apunta a un SystemPromptDef reusable
// (ProjectConfig.systemPrompts), o texto fijo inline sin necesidad de crear
// una entrada aparte. Se pueden mezclar libremente en el mismo array — ver
// resolveSystemPromptBlocks en packages/agent-engine/src/system-prompt-blocks.ts.
//
// La UI web (AgentEditorModal.vue) solo administra la parte string (ids) vía
// un multiselect de checkboxes — cualquier entrada `{text}` que ya exista en
// el agente (típicamente puesta a mano en un deploy YAML headless, nunca
// generada por esa UI) se preserva tal cual al guardar, no se pierde ni se
// vuelve editable ahí.
export const SystemPromptRefSchema = z.union([z.string(), z.object({ text: z.string() }).strict()])
export type SystemPromptRef = z.infer<typeof SystemPromptRefSchema>

export const ProjectSettingsSchema = z.object({
  name: z.string().optional(),
  language: z.string().optional(),
  // Tope de agentes corriendo a la vez PARA ESTE PROYECTO. Override del
  // default global (IA_FLOW_MAX_CONCURRENT_DISPATCHES) — ver
  // SourceDispatcher.atCapacity en @ia-flow/issue-sources. Los items que no
  // entran no se descartan: quedan en el backlog `deferred` y se reintentan
  // cuando se libera un slot.
  // `undefined` o `0` = heredar el default global (0 NO significa "frenar
  // todo" — misma decisión que el env knob, ver dispatch/env.ts).
  maxConcurrentDispatches: z.number().int().nonnegative().optional(),
  // Default del proyecto, aplicado a TODOS sus agentes sin que cada uno
  // tenga que listar nada — ver Agent.ts, resolveSystemPromptBlocks. Vive en
  // `Project.settings.systemPrompts` (el bag abierto), no en una columna
  // nueva; acá está tipado porque ProjectConfig.project es lo que el motor
  // de templates/system-prompt consume directamente.
  systemPrompts: z.array(SystemPromptRefSchema).optional(),
  // Default del proyecto para el pedido de review en Slack: el caso normal es
  // que todos los repos compartan canal y revisores, y el override por repo sea
  // la excepción. Cada campo cae por separado — ver `resolveSlackReviewTarget`.
  //
  // `.nullish()` y no `.optional()` porque `settings` es un bag que el PATCH
  // **mergea por key**: limpiar un campo desde la UI persiste un `null`, no
  // borra la key. Con `.optional()` ese null hacía fallar el `safeParse` del
  // objeto ENTERO y `.data` quedaba `undefined`, así que borrar el texto se
  // llevaba puestos también el canal y los reviewers del proyecto — y el botón
  // "Solicitar review" se apagaba para todos los repos que heredaban.
  slackReviewChannel: z.string().nullish(),
  slackReviewers: z.array(SlackMemberRefSchema).nullish(),
  slackReviewMessage: SlackReviewMessageSchema.nullish(),
  /**
   * Reglas GLOBALES que este proyecto no quiere correr.
   *
   * ── Qué problema resuelve ────────────────────────────────────────────────
   *
   * Una regla global la ven TODOS los proyectos: `IRuleRepository.visibleTo`
   * devuelve las del proyecto más las globales, y el matcher las ordena por
   * especificidad, así que una global dispara sobre los issues de cualquiera.
   * Eso es lo que se quiere para el 90% del roster —y por eso el pipeline se
   * define una vez— pero deja sin respuesta la pregunta obvia: *este proyecto
   * no*.
   *
   * Hasta acá las únicas dos salidas eran malas: apagar la regla en General
   * (que la apaga para TODOS) o estrecharle el `when` con una condición por
   * cada proyecto que no la quiere — o sea, hacer que la regla global sepa de
   * sus excepciones, que es exactamente lo que no escala.
   *
   * ── Por qué acá y no un `enabled` por proyecto en la regla ───────────────
   *
   * Porque no es una propiedad de la regla: la misma regla sigue corriendo en
   * los otros N proyectos. Es una decisión DEL PROYECTO sobre lo que hereda,
   * igual que `systemPrompts` o el cap de dispatches. Una columna en `rules`
   * habría necesitado una fila por (proyecto, regla) para guardar un booleano,
   * y habría dejado el `enabled` de la regla con dos significados.
   *
   * `.nullish()` y no `.optional()` por lo mismo que los campos de Slack de
   * arriba: `settings` se mergea por key, así que vaciar la lista desde la UI
   * persiste un `null` — y con `.optional()` ese null hacía fallar el
   * `safeParse` del objeto ENTERO, llevándose puesto el resto de los settings.
   */
  disabledRuleIds: z.array(z.string()).nullish(),
})

/**
 * ¿Este proyecto apagó esta regla heredada?
 *
 * Son DOS condiciones y las dos importan: el id está en la lista **y** la
 * regla es global. Lo segundo es lo que evita que apagar una global se lleve
 * puesta una regla propia que casualmente comparta id — una propia ya tiene su
 * `enabled`, que es donde se apaga.
 *
 * Es una función y no un `includes` suelto porque la usan tres consumidores
 * —el repositorio que arma lo visible, la vista de pipeline y la UI del
 * toggle— y repetir la regla en cada uno es como se desincronizan.
 */
export function isRuleDisabledInProject(
  settings: { disabledRuleIds?: string[] | null } | null | undefined,
  rule: { id: string; projectId?: string | null },
): boolean {
  if (rule.projectId != null) return false
  return settings?.disabledRuleIds?.includes(rule.id) ?? false
}

/**
 * La otra mitad de `isRuleDisabledInProject`: cómo queda la lista al prender o
 * apagar UNA regla.
 *
 * Toma la lista y una intención, no una lista nueva, y por eso el que escribe
 * es el server: `disabledRuleIds` la comparten todas las reglas del proyecto,
 * así que si el cliente mandara su copia entera, dos pestañas apagando reglas
 * distintas se pisarían — la segunda escribiría un estado ya viejo y desharía
 * la baja de la primera sin que nada fallara.
 *
 * Idempotente en las dos direcciones: apagar dos veces no duplica el id, y
 * prender algo que no estaba no cambia nada.
 */
export function toggleDisabledRuleId(
  current: readonly string[],
  ruleId: string,
  enabled: boolean,
): string[] {
  return enabled ? current.filter((id) => id !== ruleId) : [...new Set([...current, ruleId])]
}

// `dataType` que un source publica en `getFields()` para un campo MULTI-VALOR
// (hoy: `Labels`). Cruza el wire — el server lo emite en /source/fields y el
// editor de outcomes lo lee para ofrecer tokens con signo (`+a,-b`) en vez de
// un valor suelto — así que vive acá y no en el paquete del source.
export const MULTI_SELECT_DATA_TYPE = 'MULTI_SELECT'

// ─── Multi-tenant Project (row in `projects` table) ──────────────────────
// A project is the top-level container that groups statuses (required),
// picks a source provider (github/local/…), and optionally overrides global
// agents / system prompts via `projectId`.

// Cómo un source anota EN LA FUENTE que un agente ya tomó un item. Es el
// único guard anti-doble-dispatch que sobrevive al proceso: los otros tres
// (el set `dispatching`, el registry de pending tasks y el lock por task del
// orquestador) viven en la RAM de ESTE daemon, así que sin marca dos daemons
// contra el mismo board despachan el mismo issue, y el scan que sigue a un
// reinicio re-despacha runs todavía vivos.
//
// Se declara en `source.config.workingMarker` y NO en `settings` a propósito:
// describe el schema de la fuente (como la url), así que participa de la
// clave de cache del SourceFactory y editarlo reconstruye la instancia.
//   · ausente → el default del source (github-projects: `Working` = `Yes`)
//   · null    → sin marca; el board no necesita ningún campo
//
// `field` puede ser un campo propio del board o `Labels`, que es multi-valor:
// ahí `on`/`off` son tokens con signo (`+ia-flow:working` / `-ia-flow:working`)
// como en cualquier `$set:` — ver parseWorkingMarker en @ia-flow/issue-sources.
export const WorkingMarkerSchema = z.object({
  field: z.string().min(1),
  on: z.string().min(1),
  off: z.string().default(''),
})

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
  // true = se aplica a TODOS los agentes visibles en su scope (ese proyecto,
  // o todos si es global) sin que cada agente liste su id en
  // `systemPrompts[]`. Ver Agent.ts, resolveSystemPromptBlocks.
  default: z.boolean().optional(),
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

// ─── Tool configuration ──────────────────────────────────────────────────
// Cada agente declara una lista plana de tools. La mayoría son solo el
// nombre (string). `bash_run` es la única con configuración propia: qué
// comandos puede ejecutar, vía patrones prefijo+wildcard (mismo mecanismo
// que las reglas `Bash(cmd:*)` de Claude Code, pero con el token final "*"
// como comodín en vez de regex). `compilePolicy` en
// packages/tools/src/policy.ts resuelve `tools[]` en el `toolNames` set +
// la config de `bash_run` que usa `packages/tools/src/exec/pattern.ts` para
// decidir, por comando, si corre.
//
// `deny` gana sobre `allow`; un comando que no matchea ningún `allow` se
// rechaza por default. No hay excepciones hardcodeadas (push a main,
// operaciones destructivas de git) — todo se controla con estos dos arrays.
export const BashRunConfigSchema = z.object({
  name: z.literal('bash_run'),
  allow: z.array(z.string().min(1)).default([]),
  deny: z.array(z.string().min(1)).default([]),
})
export type BashRunConfig = z.infer<typeof BashRunConfigSchema>

export const AgentToolEntrySchema = z.union([z.string().min(1), BashRunConfigSchema])
export type AgentToolEntry = z.infer<typeof AgentToolEntrySchema>

export const WhenConditionSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.string().optional(),
  logic: z.enum(['and', 'or']).optional(),
})

// Un candidato de provider dentro de AgentDefinition.provider cuando este
// declara varios (ver AgentProviderSchema más abajo). `when` usa el mismo DSL
// estructurado que AgentActivationSchema.when (evaluado sin I/O por
// evalWhen) — ausente = candidato siempre elegible estructuralmente.
export const AgentProviderChoiceSchema = z.object({
  providerId: z.string(),
  when: z.union([z.array(WhenConditionSchema), z.record(z.string(), z.string())]).optional(),
  // Descripción en texto libre — mismo campo/forma que
  // AgentActivationSchema.whenText, ver el comentario ahí para por qué vive
  // separado de `when` en vez de fundirse en su DSL.
  whenText: z.string().optional(),
})
export type AgentProviderChoice = z.infer<typeof AgentProviderChoiceSchema>

// Forma de AgentDefinition.provider. El string plano es la forma original y
// sigue siendo válida — no rompe ningún agente existente: se resuelve
// directo, sin `when` ni Haiku. El array es la forma nueva, opt-in, para un
// agente que declara varios providers candidatos.
export const AgentProviderSchema = z.union([z.string(), z.array(AgentProviderChoiceSchema).min(1)])
export type AgentProvider = z.infer<typeof AgentProviderSchema>

// Criterios de activación de un agente. El engine los evalúa en este orden
// (project → repo → status → when) y ejecuta el PRIMER agente que cumple los
// cuatro, ordenado por `position`. En los tres primeros, `null`/`undefined`
// significa "sin restricción": el agente matchea cualquier valor.
export const AgentActivationSchema = z.object({
  // null / undefined = global (visible y elegible en cualquier proyecto)
  projectId: z.string().nullable().optional(),
  // Nombre del repo dentro del proyecto del agente (la PK de `repos` es
  // `(name, project_id)`, no hay id sintético). null = cualquier repo.
  // Matchea por pertenencia contra `task.repos[]`, igual que el alias
  // `repository` del DSL de condiciones.
  repoName: z.string().nullable().optional(),
  // null = el agente es candidato en cualquier status del pipeline.
  statusName: z.string().nullable().optional(),
  // Cuándo el dispatcher corre este agente igual aunque el issue esté
  // bloqueado por dependencias sin terminar (ver ITaskSource.getBlockers).
  // Default false — un issue bloqueado se skipea. Vivía en
  // StatusConfig.allowBlocked; ahora es del agente porque el gate real
  // ocurre contra el agente que se va a ejecutar, no contra el status en
  // abstracto (ver TaskDispatcher.dispatch — ya no depende de `statuses`).
  allowBlocked: z.boolean().optional(),
  // Condiciones contra los campos del issue. Array con lógica por condición;
  // el record plano es el formato legacy (todo-AND). Ausente = siempre matchea.
  when: z.union([z.array(WhenConditionSchema), z.record(z.string(), z.string())]).optional(),
  // Criterio de activación en texto libre — pensado como un quinto filtro,
  // hermano de `when` pero fuera de su DSL, para expresar algo que `evalWhen`
  // no puede ("este cambio tiene efecto observable en runtime").
  //
  // DEUDA: su único evaluador (`selectAgentGated` en
  // `packages/agent-engine/src/agent-text-gate.ts`) se borró por ser código
  // muerto — el refactor a reglas sobre eventos (#122) dejó de llamarlo y
  // nada lo reemplazó. Sin evaluador Y sin ningún input en el editor de
  // agentes (`apps/web/src/features/agents/**`) que lo escriba, el campo está
  // completamente huérfano hoy — sólo sobrevive en este schema y en lo que ya
  // haya persistido. El `whenText` que SÍ funciona es el de la regla
  // (`Rule.whenText`, editable en `RuleScopeEditor.vue`/`RuleEditorModal.vue`
  // y evaluado por `daemon.ts` vía `classifyAgent`/`toRuleClassificationInput`)
  // — no lo confundas con este.
  //
  // Ojo con el nombre repetido: `AgentProviderChoiceSchema.whenText` es OTRO
  // campo con otra semántica (desempata entre >1 provider, nunca rechaza al
  // único candidato); ninguno de los tres `whenText` del sistema comparte
  // implementación con los otros dos.
  whenText: z.string().optional(),
  // Orden de evaluación. Menor gana el desempate cuando varios agentes
  // matchean los mismos criterios.
  position: z.number().optional(),
})

// Qué escribe el agente de vuelta al issue en cada transición del run.
// Vivían en `StatusAgentEntry`; ahora son parte de la definición del agente.
//
// Un solo canal por slot: `$set:` contra los campos del source, tal como los
// define `ProjectSource.getFields()`. Un campo de un solo valor se asigna
// (`Priority=high`); uno multi-valor (`Labels`) recibe operaciones con signo
// (`Labels=+agent:review,-agent:build`) y es el source quien las resuelve
// contra el valor actual — ver applyMultiValueOps en @ia-flow/issue-sources.
// El slot acepta además un nombre de status pelado como forma corta de
// `$set:status=<nombre>`.
//
// Antes existía un segundo canal (`onProcessLabels`/`onFinishLabels`/
// `onErrorLabels` con el prefijo `$labels:`) que aplicaba las labels con una
// primitiva aparte (`setLabels`). Se eliminó: las labels no son un concepto
// paralelo al de campo, son el campo multi-valor del source, y tenerlas en
// dos canales obligaba a la UI a serializar una misma fila del editor en dos
// lugares distintos. Migración 039 convierte las filas viejas.
//
// ## `exits` — antes `onFinish` / `onError`
//
// Un run termina aplicando UNA transición. `onFinish` y `onError` ya eran dos
// salidas con nombre hardcodeado: el engine elegía entre ellas según cómo
// terminó el run. `exits` las nombra explícitamente, lo que quita un caso
// especial en vez de agregar un concepto — y de paso deja declarar salidas
// ADICIONALES que el agente puede elegir por nombre.
//
// El caso que lo motivó: un refiner que descubre que el PRD está bien y lo que
// falla es la implementación necesita devolver el issue al builder, no mandarlo
// a `blocked`. Con dos slots fijos eso no se podía expresar.
//
// `success` y `error` son nombres RESERVADOS: son el default que el engine
// elige según cómo terminó el run (equivalentes exactos de `onFinish` y
// `onError`). Cualquier otra clave es una salida que el agente puede pedir por
// nombre — y sólo por nombre: nunca recibe un mapa de campos libre. El operador
// sigue dibujando todas las aristas del grafo; el agente sólo elige entre las
// que ya están dibujadas, así que el pipeline se sigue leyendo entero acá.
//
// Un agente que sólo declara `success`/`error` no puede elegir nada: el
// parámetro `exit` ni se le ofrece (ver `select_exit` y el `exit` de
// complete_task/fail_task en packages/tools/src/task/task.ts). Ausente = no se
// aplica ninguna transición, igual que un `onFinish` vacío.
//
// Migración 050 convierte las filas viejas (`on_finish`/`on_error` → `exits`).
export const SUCCESS_EXIT = 'success'
export const ERROR_EXIT = 'error'

// ## `comment` — dónde queda el comentario de cierre de un run
//
// La regla, en una línea: **el comentario vive donde vive lo que el hallazgo
// cambia**. Si cambia QUÉ hay que construir (el PRD, el alcance), va al issue;
// si critica CÓMO está escrito este código, va al PR.
//
// El default es `pr-else-issue` porque, una vez que existe un PR, casi todo
// comentario del pipeline es sobre el código — hacer que cada agente lo declare
// sería config que sólo repite el default. Antes de que haya PR cae al issue
// solo, así que el arranque del pipeline no necesita declarar nada.
//
// La excepción que obliga a que esto sea declarable por SALIDA y no por agente:
// un e2e-tester tiene dos clases de hallazgo. "Este código rompe en runtime"
// pertenece al PR; "esto no hace lo que el PRD pide" manda el issue de vuelta a
// refinamiento y pertenece al ISSUE — el PR que lo motivó se puede cerrar
// cuando el enfoque cambie, y ahí el hallazgo quedaría enterrado en un PR
// cerrado que ya nadie lee (ver `openPullRequests` en @ia-flow/issue-sources:
// sólo se leen y escriben PRs abiertos).
//
// Elegir mal nunca ESCONDE nada: `loadComments` mergea issue + PRs abiertos
// para todos los agentes, así que el destino decide dónde queda registrado de
// forma durable, no quién puede verlo.
export const CommentTargetSchema = z.enum(['issue', 'pr', 'pr-else-issue'])
export type CommentTarget = z.infer<typeof CommentTargetSchema>

/** Lo que se aplica cuando ni la salida ni el agente declaran `comment`. */
export const DEFAULT_COMMENT_TARGET: CommentTarget = 'pr-else-issue'

/**
 * Una salida: la transición `$set:`, opcionalmente CUÁNDO usarla, y
 * opcionalmente DÓNDE comentar al tomarla.
 *
 * El `when` no es documentación: viaja al enum de `select_exit` como
 * descripción, así que es lo que el modelo lee para decidir. Sin él, el agente
 * ve el nombre pelado (`back-to-build`) y depende de que alguien se haya
 * acordado de explicarlo en el prompt — o sea, declarar la salida y explicarla
 * son dos ediciones en dos lugares, y olvidar la segunda deja config muerta.
 * Es el mismo modo de falla que tuvo `whenText`, declarado y sin consumir.
 *
 * La forma string sigue siendo válida y es la correcta para `success`/`error`:
 * esas dos las elige el engine, el agente nunca las pide, así que no tienen
 * nada que explicarle. Pasan a la forma larga sólo si necesitan `comment`.
 */
export const AgentExitSchema = z.union([
  z.string(),
  z.object({
    set: z.string(),
    when: z.string().optional(),
    comment: CommentTargetSchema.optional(),
  }),
])
export type AgentExit = z.infer<typeof AgentExitSchema>

/** La transición de una salida, venga en forma corta o larga. */
export function exitSet(exit: AgentExit | undefined): string | undefined {
  if (exit == null) return undefined
  return typeof exit === 'string' ? exit : exit.set
}

/** Cuándo usarla — sólo la forma larga la trae. */
export function exitWhen(exit: AgentExit | undefined): string | undefined {
  return exit == null || typeof exit === 'string' ? undefined : exit.when
}

/** Dónde comentar al tomar esta salida — sólo la forma larga la trae. */
export function exitComment(exit: AgentExit | undefined): CommentTarget | undefined {
  return exit == null || typeof exit === 'string' ? undefined : exit.comment
}

/**
 * Destino efectivo: **salida > agente > default**.
 *
 * Los tres niveles existen por una razón cada uno: el default cubre a la
 * mayoría sin escribir nada, el del agente hace que un refiner cueste una línea
 * en vez de una por salida, y el de la salida es el único que puede expresar
 * que un mismo agente mande un hallazgo al PR y otro al issue.
 */
export function resolveCommentTarget(
  exit: AgentExit | undefined,
  agentDefault: CommentTarget | undefined,
): CommentTarget {
  return exitComment(exit) ?? agentDefault ?? DEFAULT_COMMENT_TARGET
}

/**
 * Un campo del contrato de salida de un agente.
 *
 * Deliberadamente NO es JSON Schema completo: lo que un agente le pasa al que
 * sigue son unos pocos valores planos, y aceptar objetos anidados invitaría a
 * mover estructura por acá en vez de por el issue —que es donde el pipeline la
 * guarda de forma durable y auditable—. Si algún día hace falta, se amplía;
 * empezar amplio no se puede deshacer.
 */
export const AgentOutputFieldSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']).default('string'),
  /** Qué tiene que poner el agente ahí. Va a la descripción del parámetro, así
   *  que es lo único que el modelo lee para saber qué se espera — sin esto ve
   *  un nombre pelado, el mismo problema que tenía una salida sin `when`. */
  description: z.string().optional(),
  /** Restringe los valores aceptados. Mismo patrón que `select_exit`: el
   *  operador declara el espacio, el modelo elige adentro. */
  enum: z.array(z.string()).optional(),
  /** Ausente ⇒ obligatorio. Un contrato donde todo es opcional no es un
   *  contrato. */
  optional: z.boolean().optional(),
})
export type AgentOutputField = z.infer<typeof AgentOutputFieldSchema>

/**
 * El contrato de salida estructurada de un agente: `campo → forma`.
 *
 * Declararlo hace tres cosas: le ofrece al agente la tool `submit_output` con
 * ese schema exacto, vuelve OBLIGATORIO llamarla antes de cerrar, y publica el
 * payload para que una regla lo pase al paso siguiente
 * (`{{steps.<paso>.output.<campo>}}`).
 *
 * **Por qué una tool y no `output_config.format` de la API.** El canal de
 * tools es lo único que funciona igual en sync y en async — es literalmente
 * por eso que el provider de terminal inyecta el MCP sintético
 * `ia-flow-tools`. `output_config` sólo existe en `anthropic-api`, así que un
 * contrato declarado no haría nada en tmux/iterm; además se comería el mensaje
 * final, que es lo que el engine publica como comentario del issue, y no deja
 * reintentar con feedback cuando el payload no sirve.
 */
export const AgentOutputSchema = z.record(z.string().min(1), AgentOutputFieldSchema)
export type AgentOutput = z.infer<typeof AgentOutputSchema>

export const AgentOutcomesSchema = z.object({
  // Hook, no destino: corre siempre al arrancar el run. Por eso NO entra en
  // `exits` — no hay nada que elegir.
  onProcess: z.string().optional(),
  exits: z.record(z.string(), AgentExitSchema).optional(),
  // Destino por defecto de TODOS los comentarios de este agente: el cierre del
  // run, `complete_task`/`fail_task` y los hitos de `add_task_comment`. Una
  // salida puede pisarlo (ver `resolveCommentTarget`). Ausente ⇒
  // `pr-else-issue`.
  //
  // El caso que lo justifica como campo de agente y no sólo de salida: un
  // refiner produce el PRD, y el PRD ES el issue — todas sus salidas comentan
  // ahí. Sin este nivel habría que repetir `comment: issue` en cada una.
  comment: CommentTargetSchema.optional(),
})

export const AgentDefinitionSchema = z
  .object({
    id: z.string(),
    provider: AgentProviderSchema,
    prompt: z.string(),
    // Mezcla de ids de SystemPromptDef (ProjectConfig.systemPrompts) y texto
    // inline (`{text: "..."}`), en el orden en que se quieren concatenar —
    // ver SystemPromptRefSchema arriba y resolveSystemPromptBlocks en
    // packages/agent-engine/src/system-prompt-blocks.ts. La UI web solo
    // administra la parte string (ids); las entradas `{text}` sobreviven un
    // guardado desde ahí sin ser editables.
    systemPrompts: z.array(SystemPromptRefSchema).optional(),
    variables: z.record(z.string(), AgentVariableValueSchema).optional(),
    // Lista plana de tools que el agente puede invocar. La mayoría son solo
    // el nombre (string) — aliases (`run_command`, `read_file`, …) resuelven
    // a los ids canónicos vía `resolveAliases` en el registry. `bash_run` es
    // la única entry con forma de objeto (ver `BashRunConfigSchema`): sin
    // esa entry, `bash_run` no está disponible. Sin `tools[]` (o vacío), el
    // agente no tiene ninguna tool — no hay fallback implícito a "todas".
    tools: z.array(AgentToolEntrySchema).optional(),
    save_output: z.boolean().optional(),
    providerConfig: AgentProviderConfigSchema.optional(),
    // References to entries in the central MCP catalog (see McpCatalogEntrySchema).
    // Expanded at dispatch time and merged into providerConfig.mcpServers; inline
    // entries take precedence so an agent can override a catalog config locally.
    mcpCatalogIds: z.array(z.string()).optional(),
    // Overrides el gate implícito del engine para auto-crear una linked branch
    // en GitHub. Cuando undefined, el engine cae a la derivación default:
    // "necesita branch si tiene write tools". Cuando true, siempre intenta
    // crear branch (útil para agentes que hacen commits vía GitHub MCP sin
    // tener write_file/edit_file locales). Cuando false, nunca crea branch
    // aunque tenga write tools.
    requiresBranch: z.boolean().optional(),
    // Tope de runs simultáneos DE ESTE AGENTE (contado sobre el registry de
    // pending tasks, cruzando proyectos). Un issue que lo excede se difiere,
    // no se descarta: vuelve al backlog y se reintenta al liberarse un slot.
    // Sirve para agentes caros o que serializan sobre un recurso externo
    // (un solo worktree, una API con rate limit propio) sin tener que bajar
    // el cap del proyecto entero.
    // `undefined` o `0` = sin límite propio (sólo aplican el cap del
    // proyecto y el del provider).
    maxConcurrentDispatches: z.number().int().nonnegative().optional(),
    /**
     * Corre igual cuando el issue está bloqueado por otro.
     *
     * Sobrevivió a la migración 059 mientras el resto de la activación se fue
     * a `rules` porque NO es un criterio de match: es una tolerancia del
     * trabajo que el agente hace. Un refinador puede refinar un issue
     * bloqueado; un implementador no debería implementarlo. Ponerlo en la
     * regla obligaría a repetirlo en cada regla que corra al mismo agente.
     */
    allowBlocked: z.boolean().optional(),
    /** Proyecto dueño de la fila; `null` = agente global. NO es activación —
     *  es de qué lista lo edita el operador y qué overlay lo ve
     *  (`IAgentRepository.visibleTo`). Filtrar POR proyecto ahora lo hace la
     *  regla, con `matchScope`. */
    projectId: z.string().nullable().optional(),
    /** Orden en la lista del editor, dentro de su ámbito. Sobrevive por lo
     *  mismo que `projectId`: es presentación, no criterio de match. */
    position: z.number().optional(),
    /**
     * Contrato de salida estructurada — ver `AgentOutputSchema`.
     *
     * Es opt-in y sin default: la enorme mayoría de los agentes cierra con
     * prosa y eso alcanza. Se declara cuando otro paso necesita LEER lo que
     * éste produjo, y declararlo lo vuelve obligatorio (el run falla si el
     * agente cierra sin llamar a `submit_output`) — un contrato que se puede
     * incumplir en silencio deja al paso siguiente trabajando con un encargo
     * mutilado, que es peor que no tener contrato.
     */
    output: AgentOutputSchema.optional(),
  })
  // El agente declara QUÉ hace y cómo termina. El CUÁNDO se fue a `rules` en
  // la migración 059 — ver RuleSchema.
  .extend(AgentOutcomesSchema.shape)

// Un status ya no cablea agentes: es solo una etapa del pipeline. Qué agente
// corre en él lo decide `AgentDefinition.statusName` (ver AgentActivationSchema).
export const StatusConfigSchema = z.object({
  name: z.string(),
  // Required at the DB layer; optional in the schema so legacy imports
  // (e.g. `ProjectConfig` YAML paste) resolve it from the target project.
  projectId: z.string().optional(),
  // Orden de la etapa en el pipeline, tal como lo persiste la tabla `statuses`.
  position: z.number().optional(),
  // DEPRECATED — no longer read by the engine. The blocker gate moved to
  // AgentActivationSchema.allowBlocked (TaskDispatcher.dispatch checks it on
  // the matched agent, not on the item's status). Kept only because the
  // `statuses` SQLite column still exists (migration 038 read it once for
  // the one-time backfill into agents.allow_blocked) — nothing in the app
  // writes it anymore (StatusConfigModal stopped sending it, so a PUT
  // through routes/statuses.ts now silently drops any value here on the
  // next full-row replace). Don't add a new writer; edit the agent instead.
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

// Why a run ended the way it did, in terms you can GROUP BY. `outcome`
// answers "did it work"; this answers "what broke", which is what a human
// (or the retro agent) needs to decide whether the fix is a prompt, a
// missing tool, a permission, or an infra problem.
//
// Derived, never authored: computed from the run's own signals by
// `classifyFailure` (packages/agent-engine/src/failure-taxonomy.ts). Null on
// rows written before this existed and on runs still in flight.
export const FailureClassSchema = z.enum([
  // Model/budget limits — the run was cut short mid-work.
  'budget_exhausted', //  max_tokens / context window / task budget
  'iteration_cap', //     hit the loop's hard iteration cap
  'server_tool_pause', // pause_turn retries exhausted
  'refusal', //           Claude declined on safety grounds
  // The agent's own configuration is wrong.
  'tool_failure', //      a large share of its tool calls errored
  'no_op', //             finished "successfully" without doing any work
  // Everything around the agent.
  'infra_error', //       git/network/workspace threw before or during the run
  'cancelled', //         a human or the divergence gate stopped it
  'unknown', //           failed, but none of the above matched
])

/**
 * Qué corrió en esta fila.
 *
 * Abierto a propósito (`string` y no un enum cerrado): los kinds salen del
 * registro de acciones (`registerAction`), así que un handler nuevo tiene que
 * poder escribir su fila sin que este schema lo autorice antes. La UI agrupa
 * lo que conoce y muestra el resto por su nombre.
 *
 * `'agent'` es el default de las filas viejas: todo lo que había en
 * `execution_logs` antes de la migración 065 era un run de agente.
 */
export const ExecutionKindSchema = z.string()
export type ExecutionKind = z.infer<typeof ExecutionKindSchema>

/**
 * Una ejecución: un run de agente, o una acción que una regla corrió.
 *
 * Las dos viven en la misma tabla porque son la misma pregunta del operador
 * —"¿qué hizo el pipeline?"— y separarlas obligaba a la pantalla a unir dos
 * listas por timestamp. Lo que las distingue es `kind`.
 *
 * **Los campos de agente son `''` en una fila que no es de agente**
 * (`agentId`, `providerId`, y `taskId`/`taskTitle` cuando el evento no trae
 * issue). Sus columnas son NOT NULL desde la migración 001, y SQLite no sabe
 * sacar un NOT NULL sin reconstruir la tabla entera: rehacer una tabla de 30+
 * columnas con datos vivos es peor negocio que un centinela documentado.
 */
/** Llamadas y errores de UNA tool dentro de un run (o sumadas en una ventana). */
export const ToolTallySchema = z.object({
  calls: z.number(),
  errors: z.number(),
})
export type ToolTally = z.infer<typeof ToolTallySchema>

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
  // IA_FLOW_INSTANCE_ID of the process that ran this agent — null/absent
  // means the main daemon itself. Headless containers (subscriptions-
  // pipeline, functional-refiner, implementer-accountant) tag every row
  // they insert, whether it stays local-only or gets forwarded to the main
  // daemon via RemoteExecutionLogRepository — see composition/container.ts.
  source: z.string().nullable().optional(),
  // Set when an operator hit "cancel" on a row owned by another process
  // (source != null) — the main daemon has no safe way to actually reach
  // into that container and stop the run (see routes/executions.ts), so
  // this is purely an advisory marker surfaced in the UI, not proof the
  // run stopped.
  cancelRequestedAt: z.string().nullable().optional(),

  // ─── Run telemetry (added in migration 045) ─────────────────────────────
  // All optional/nullable: rows predating the migration have none of it, and
  // async/terminal providers can't measure token usage at all (the model
  // runs in a Claude Code session this process doesn't account for). `null`
  // means "not measured here", not "zero".
  durationMs: z.number().nullable().optional(),
  tokensIn: z.number().nullable().optional(),
  tokensOut: z.number().nullable().optional(),
  cacheReadTokens: z.number().nullable().optional(),
  cacheCreationTokens: z.number().nullable().optional(),
  iters: z.number().nullable().optional(),
  toolCalls: z.number().nullable().optional(),
  toolErrors: z.number().nullable().optional(),
  failureClass: FailureClassSchema.nullable().optional(),
  // Correlates this row with `daemon.log` lines and `/api/hook-events`
  // payloads, which already carry the same runId.
  runId: z.string().nullable().optional(),
  // SHA-256 (first 12 hex chars) de la CONFIGURACIÓN del agente con la que
  // corrió: prompt crudo, system prompts resueltos, tools, provider y
  // salidas (`hashAgentConfig`). Dos runs "del mismo" agente sólo son
  // comparables cuando esto coincide — es lo que permite atribuir una
  // regresión a una edición concreta y no al id del agente en abstracto.
  agentPromptHash: z.string().nullable().optional(),

  // ─── Telemetría de costo (migración 067) ─────────────────────────────────
  // Hash de SÓLO los bloques de system prompt resueltos. `agentPromptHash` ya
  // los incluye, pero mezclado con el resto de la config: cuando cambia, no
  // dice si lo que se editó fue el agente o un system prompt compartido por
  // todo el roster. Con los dos hashes la pregunta se contesta cruzándolos.
  systemPromptHash: z.string().nullable().optional(),
  // Modelo que sirvió el run. Sin él los tokens no tienen precio: 3M de
  // entrada en Haiku y 3M en Opus no son comparables. Para runs de terminal
  // sale de la transcripción de Claude Code; null si no se pudo observar.
  model: z.string().nullable().optional(),
  // Llamadas y errores por tool. `toolCalls`/`toolErrors` dicen cuánto; esto
  // dice EN QUÉ: 50 `fs_read` es un problema de descubrimiento del repo, 10
  // errores de `bash_run` es la policy. Chico por construcción (una entrada
  // por tool, no por llamada), así que cabe como JSON en la fila.
  toolBreakdown: z.record(z.string(), ToolTallySchema).nullable().optional(),

  // ─── Contrato de cierre (migración 048) ─────────────────────────────────
  // Lo que hace falta para cerrar el run sin el registry en memoria: si el
  // proceso reinicia (o el watchdog borra la entrada por una lectura de
  // liveness equivocada), la sesión del agente sigue viva y su
  // `complete_task` tiene que poder aterrizar igual. Con estos tres campos
  // la fila alcanza para reconstruir la entrada pendiente.
  //
  // `initialStatus` es contra lo que se compara el status fresco para saber
  // si el prompt ya movió la tarea por su cuenta. `exits` se congela acá
  // —en vez de releerse del AgentDefinition al cerrar— porque
  // el agente se puede editar mientras el run corre: se aplica lo que el run
  // pactó al arrancar, no lo que el agente dice hoy.
  initialStatus: z.string().nullable().optional(),
  // El mapa de salidas con el que el run arrancó. Reemplaza a `onFinish` /
  // `onError`, que la migración 050 colapsó acá — el schema se había quedado
  // atrás y el repositorio venía escribiendo un campo que el tipo no declaraba.
  exits: z.record(z.string(), z.unknown()).nullable().optional(),
  // Quién cerró la fila: `true` = un tool del agente (complete_task /
  // fail_task), que ya publicó su comentario y aplicó su transición. Es la
  // clave de idempotencia del cierre. `outcome` no sirve para esto: la
  // barrida de huérfanos de un reinicio también escribe `outcome: 'error'`,
  // y confundir ambos descartaría como duplicado el cierre tardío de un
  // agente que siguió trabajando después del reinicio.
  finalizedByTool: z.boolean().nullable().optional(),

  // ─── Trazas por usuario (migración 057) ─────────────────────────────────
  // Los assignees del issue AL MOMENTO del run. Es una foto, no una
  // referencia: el issue puede cambiar de dueño después y la pregunta que esto
  // contesta ("¿cómo le fue a los issues de fulano?") es sobre quién lo tenía
  // cuando el agente corrió.
  //
  // `null` = no se registró (filas previas a la migración). `[]` = corrió sin
  // assignee. La distinción importa: son "no sé" y "nadie", y colapsarlas haría
  // que un filtro por "sin asignar" mienta sobre todo el histórico viejo.
  assignees: z.array(z.string()).nullable().optional(),

  // ─── La cadena que lo causó (migración 065) ─────────────────────────────
  // Una ejecución dejó de ser "un run de agente": es cualquier cosa que una
  // regla ejecutó. `kind` distingue las filas, y los tres campos de abajo son
  // la causa que antes sólo vivía en memoria y en una línea de log que rota.
  kind: ExecutionKindSchema.optional(),
  /**
   * La regla que la disparó. `null` en un dispatch que no vino de una regla
   * (un run manual, un sub-agente) — igual que `RunningAgent.ruleId`.
   */
  ruleId: z.string().nullable().optional(),
  /**
   * El evento que la causó. Es la clave que agrupa: todas las filas de un
   * mismo disparo de regla comparten `(eventId, ruleId)`, así que la
   * notificación y el agente que corrieron juntos se leen juntos sin
   * inventar una tabla padre.
   */
  eventId: z.string().nullable().optional(),
  eventType: z.string().nullable().optional(),
  /** Índice dentro del `do[]` de la regla — el orden en que se ejecutaron. */
  position: z.number().nullable().optional(),
  /**
   * El run que la lanzó, para lo que sí es una jerarquía: un sub-agente de
   * `run_agent` cuelga de su padre. `parentRunId` ya existía pero sólo en el
   * registry en memoria, así que un reinicio le borraba el padre a un hijo
   * que seguía corriendo.
   */
  parentId: z.string().nullable().optional(),
  /**
   * El run anterior cuyo checkpoint retomó ésta — distinto de `parentId`
   * (jerarquía de sub-agente): acá el run anterior es la MISMA task, no un
   * padre delegando en un hijo. `null` cuando arrancó de cero.
   */
  resumedFromRunId: z.string().nullable().optional(),
})

export const ExecutionLogFiltersSchema = z.object({
  projectId: z.union([z.string(), z.array(z.string())]).optional(),
  taskId: z.string().optional(),
  // Multi-select filters: any of the given values matches. A plain string
  // still works for backwards compat with single-value callers.
  agentId: z.union([z.string(), z.array(z.string())]).optional(),
  providerId: z.union([z.string(), z.array(z.string())]).optional(),
  outcome: z.union([OutcomeSchema, z.array(OutcomeSchema)]).optional(),
  source: z.union([z.string(), z.array(z.string())]).optional(),
  failureClass: z.union([FailureClassSchema, z.array(FailureClassSchema)]).optional(),
  // Se llama `assignee` (singular) aunque la columna guarde una lista: el
  // filtro es "ejecuciones de este usuario", y una fila matchea si el usuario
  // está entre sus assignees. Mismo contrato multi-valor que el resto —
  // repetir el query param es OR.
  assignee: z.union([z.string(), z.array(z.string())]).optional(),
  // `kind: 'agent'` es lo que devuelve la lista de siempre. Sin filtro entran
  // también las acciones, que es el listado nuevo del pipeline completo.
  kind: z.union([ExecutionKindSchema, z.array(ExecutionKindSchema)]).optional(),
  eventId: z.string().optional(),
  // Multi-select como los demás: mirar dos reglas juntas es la misma pregunta
  // que mirar dos agentes juntos.
  ruleId: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().optional(),
})

export const ExecutionLogArraySchema = z.array(ExecutionLogSchema)

// ─── Execution stats (GET /api/executions/stats) ──────────────────────────
// Aggregate health per agent over a time window. Computed in SQL rather than
// derived in the browser from a page of rows: the interesting windows (a
// month of runs) are far larger than any list the UI would fetch, and a
// success rate computed off the last 100 rows silently lies.

export const ExecutionStatsFiltersSchema = z.object({
  projectId: z.union([z.string(), z.array(z.string())]).optional(),
  agentId: z.union([z.string(), z.array(z.string())]).optional(),
  source: z.union([z.string(), z.array(z.string())]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

// Los campos de eficiencia llevan `.default(...)`: son aditivos, y un panel que
// se cae entero porque el server todavía no los manda es peor que uno que
// muestra "—" en dos columnas. El default sólo cubre la lectura — el tipo de
// salida los sigue exigiendo, así que el server no puede omitirlos por
// descuido.
export const AgentHealthSchema = z.object({
  agentId: z.string(),
  /** Finished runs only — a run still in flight has no outcome to count. */
  runs: z.number(),
  success: z.number(),
  error: z.number(),
  cancelled: z.number(),
  truncated: z.number(),
  /** success / runs, or null when the agent has no finished runs in the
   *  window (0/0 is not a rate — rendering it as 0% would flag a brand-new
   *  agent as broken). */
  successRate: z.number().nullable(),
  /** Histogram keyed by FailureClass. Only non-zero classes appear. A run
   *  whose class is null (a clean success) is counted in `success`, not
   *  here — so these need not sum to `runs`. */
  failureClasses: z.record(z.string(), z.number()),
  avgDurationMs: z.number().nullable(),
  /** El run más lento del percentil 95. El promedio esconde justo el outlier
   *  que se quiere encontrar: un run de 40 vueltas entre 20 normales casi no
   *  mueve la media, pero es el que hay que mirar. Null cuando ningún run de
   *  la ventana registró duración. */
  p95DurationMs: z.number().nullable().default(null),
  /** Tokens de entrada FRESCOS — `input_tokens` de la API, que excluye lo
   *  servido desde cache. Es la parte que se paga a precio pleno. */
  tokensIn: z.number(),
  tokensOut: z.number(),
  /** Entrada servida desde el cache de prompts (≈0.1x el precio de `tokensIn`). */
  cacheReadTokens: z.number().default(0),
  /** Entrada escrita al cache (≈1.25x). Un valor alto frente a `cacheReadTokens`
   *  significa que el prefijo se re-escribe en vez de reusarse — TTL vencido, o
   *  un prefijo que cambia entre requests. */
  cacheCreationTokens: z.number().default(0),
  /** cacheRead / (cacheRead + tokensIn) — qué fracción de la entrada se sirvió
   *  del cache. La métrica de costo con más señal del panel: separa "este
   *  agente trabaja mucho" de "este agente paga mal". Null cuando la ventana
   *  no tiene tokens observables (los runs de terminal no los reportan). */
  cacheHitRate: z.number().nullable().default(null),
  /** Vueltas del loop de tools, sumadas. Con `tokensIn` da el costo por vuelta,
   *  que es lo que distingue un agente que itera mucho de uno cuyo historial
   *  se re-manda sin cachear. */
  iters: z.number().default(0),
  toolCalls: z.number(),
  toolErrors: z.number(),
  /** Histograma del `stop_reason` de la API. Sólo clases no nulas. `max_tokens`
   *  acá señala presupuesto corto, que `truncated` cuenta sin decir por qué. */
  stopReasons: z.record(z.string(), z.number()).default({}),
  lastRunAt: z.string().nullable(),
  /** Hashes de configuración distintos en la ventana. >1 significa que el
   *  agente se editó mientras corría, así que su tasa agregada mezcla dos
   *  agentes distintos en todo menos el nombre — el panel avisa en vez de
   *  promediar en silencio.
   *
   *  El hash sale de `hashAgentConfig` (prompt crudo + system + tools +
   *  provider + salidas), NO del prompt que cada run mandó: ése lleva las
   *  variables ya resueltas y daba un hash por run. */
  promptVersions: z.number(),
  /** Hashes distintos de los system prompts resueltos en la ventana. Cruzado
   *  con `promptVersions` dice QUÉ cambió: si éste se movió y aquél no, la
   *  edición fue en un system prompt compartido, no en el agente. */
  systemPromptVersions: z.number().default(0),
  /** Costo estimado en USD de los runs con tokens observables, a precio de
   *  lista del modelo de cada run. Null cuando ningún run trae modelo o el
   *  modelo no está en la tabla de precios — un 0 ahí leería como "gratis".
   *  Es la columna que convierte la tabla en una lista de prioridades: los
   *  tokens sin modelo no se pueden comparar entre agentes. */
  costUsd: z.number().nullable().default(null),
  /** Runs por modelo. Más de una clave significa que el agente cambió de
   *  modelo en la ventana (o corre con `whenText` entre providers), y sus
   *  tokens promedian cosas de precio distinto. */
  models: z.record(z.string(), z.number()).default({}),
  /** Llamadas y errores sumados por tool. Es lo que le da sentido a
   *  `toolCalls`: 68 llamadas no dicen nada, 50 `fs_read` sí. */
  toolBreakdown: z.record(z.string(), ToolTallySchema).default({}),
})

export const ExecutionStatsSchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  totals: z.object({
    runs: z.number(),
    success: z.number(),
    error: z.number(),
    cancelled: z.number(),
    truncated: z.number(),
    successRate: z.number().nullable(),
    failureClasses: z.record(z.string(), z.number()),
    stopReasons: z.record(z.string(), z.number()).default({}),
    tokensIn: z.number(),
    tokensOut: z.number(),
    cacheReadTokens: z.number().default(0),
    cacheCreationTokens: z.number().default(0),
    cacheHitRate: z.number().nullable().default(null),
    iters: z.number().default(0),
    /** Suma de los `costUsd` por agente; null si ninguno pudo estimarse. */
    costUsd: z.number().nullable().default(null),
  }),
  agents: z.array(AgentHealthSchema),
})

// ─── Agent detail (GET /api/executions/stats/:agentId) ────────────────────
// The drill-down behind one row of the health panel. The panel answers "which
// agent should I look at"; this answers "why did this one get worse", which
// needs cuts the aggregate deliberately doesn't carry.

// Success rate per prompt version. This is the cut that makes a regression
// attributable: same agent id, different prompt, different rate. Without it,
// editing a prompt just moves an average nobody can decompose.
// Lo que se compara entre dos versiones. Además de la tasa de éxito lleva el
// costo por run: una edición del prompt que no cambia la tasa pero duplica
// las vueltas es una regresión igual, y la tasa sola no la ve.
const VersionStatsFields = {
  runs: z.number(),
  success: z.number(),
  successRate: z.number().nullable(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  /** Vueltas del loop, sumadas. Con `runs` da vueltas por run. */
  iters: z.number().default(0),
  /** Entrada fresca sumada (precio pleno). */
  tokensIn: z.number().default(0),
  cacheHitRate: z.number().nullable().default(null),
  /** Costo estimado; null cuando ningún run de la versión trae modelo. */
  costUsd: z.number().nullable().default(null),
}

export const PromptVersionStatsSchema = z.object({
  /** null groups every run from before prompt hashing existed. */
  promptHash: z.string().nullable(),
  ...VersionStatsFields,
})

// Misma comparación, cortada por el hash de los system prompts. Una fila
// acá que se mueve mientras `byPromptVersion` muestra la misma cantidad de
// versiones señala una edición en un prompt COMPARTIDO — afecta a todo el
// roster, no a este agente.
export const SystemPromptVersionStatsSchema = z.object({
  systemPromptHash: z.string().nullable(),
  ...VersionStatsFields,
})

export const DailyRunStatsSchema = z.object({
  day: z.string(),
  runs: z.number(),
  success: z.number(),
})

// Enough of a failed run to recognise it without opening the drawer.
export const RecentFailureSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  startedAt: z.string(),
  outcome: OutcomeSchema.nullable(),
  failureClass: FailureClassSchema.nullable(),
  stopReason: z.string().nullable(),
  /** Truncated server-side — these can hold a whole raw API response. */
  errorExcerpt: z.string().nullable(),
})

export const AgentDetailSchema = z.object({
  agentId: z.string(),
  health: AgentHealthSchema,
  byPromptVersion: z.array(PromptVersionStatsSchema),
  bySystemPromptVersion: z.array(SystemPromptVersionStatsSchema).default([]),
  byDay: z.array(DailyRunStatsSchema),
  recentFailures: z.array(RecentFailureSchema),
})

export type PromptVersionStats = z.infer<typeof PromptVersionStatsSchema>
export type SystemPromptVersionStats = z.infer<typeof SystemPromptVersionStatsSchema>
export type DailyRunStats = z.infer<typeof DailyRunStatsSchema>
export type RecentFailure = z.infer<typeof RecentFailureSchema>
export type AgentDetail = z.infer<typeof AgentDetailSchema>

export type ExecutionStatsFilters = z.infer<typeof ExecutionStatsFiltersSchema>
export type AgentHealth = z.infer<typeof AgentHealthSchema>
export type ExecutionStats = z.infer<typeof ExecutionStatsSchema>

export type ExecutionLog = z.infer<typeof ExecutionLogSchema>
export type FailureClass = z.infer<typeof FailureClassSchema>
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
  // ── Filtros sobre `extras` ───────────────────────────────────────────────
  // Todos siguen la misma regla y el mismo camino en la ruta: la línea entra
  // sólo si su `extras[campo]` está entre los valores pedidos. Una línea que no
  // trae el campo NO entra — la infraestructura (migraciones, watcher, WS) no
  // pertenece a ningún agente ni a ninguna tarea, así que preguntar por una es
  // pedir explícitamente lo que sí tiene dueño.
  //
  // Multi-select con la misma forma que `module`: un string para una consulta
  // de un valor, un array para varios.
  //
  // Filters entries whose extras.projectId matches. Only orchestrator/
  // provider logs currently carry projectId — infra events without it are
  // dropped when this filter is set.
  projectId: z.union([z.string(), z.array(z.string())]).optional(),
  // Filters entries whose extras.runId matches — the correlation id shared
  // by every log line and the execution_logs row of a single agent run.
  runId: z.union([z.string(), z.array(z.string())]).optional(),
  /** `extras.agentId` — qué agente escribió la línea. */
  agentId: z.union([z.string(), z.array(z.string())]).optional(),
  /** `extras.taskId` — sobre qué issue. Es el mismo id que la columna
   *  `taskId` de `execution_logs`, así que un filtro se copia de un lado al
   *  otro sin traducir nada. */
  taskId: z.union([z.string(), z.array(z.string())]).optional(),
  /** `extras.ruleId` — qué regla lo produjo. Es lo único que correlaciona las
   *  líneas de una ACCIÓN: no hay `runId` que estampar porque una acción no es
   *  un run del agente, así que sus handlers loguean la regla. */
  ruleId: z.union([z.string(), z.array(z.string())]).optional(),
  /** `extras.task` — el título de la tarea, tal cual lo manda `logCtx` en
   *  `AnthropicApiProvider.run` (junto a `taskId`, que es el id opaco). Sólo
   *  el camino sync lo estampa hoy — un agente async (tmux/iterm) no tiene
   *  este campo en sus líneas. */
  task: z.union([z.string(), z.array(z.string())]).optional(),
  // Filters entries whose extras.source matches — the IA_FLOW_INSTANCE_ID of
  // the process that emitted the line (unset = the main daemon itself; a
  // headless container like "subscriptions-pipeline" tags every line it
  // writes, locally and when forwarded — see apps/server/src/logger.ts).
  // Multi-select, same shape as `module`.
  source: z.union([z.string(), z.array(z.string())]).optional(),
  // ── Búsqueda por patrón sobre `extras` ───────────────────────────────────
  // Cada entrada es `"<clave>:<patrón>"` (ej. `"taskId:abc*"`), con `*`
  // (cualquier secuencia) y `?` (un carácter) como únicos comodines — NO es
  // una regexp arbitraria: corre en el event loop del daemon sobre cada
  // línea de un log que puede tener decenas de miles, y Bun no expone un
  // motor de regex con timeout, así que un patrón adversarial con
  // backtracking catastrófico colgaría el proceso entero (ver
  // `globMatchFull` en `server-logs.ts`). A diferencia de los filtros de
  // arriba (membership exacto contra una lista de valores conocidos), esto
  // sirve para un campo o un patrón que no está en ningún selector — el
  // mismo rol que `search` cumple para `msg`. Multi-select: varias
  // entradas se exigen todas (AND), incluso sobre la misma clave.
  extra: z.union([z.string(), z.array(z.string())]).optional(),
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
export const ServerLogSourcesSchema = z.array(z.string())

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
  // PostToolUse only. The hook stringifies `tool_response` into `result`,
  // which makes a failed tool indistinguishable from a successful one
  // downstream — so the hook script inspects the raw object and reports the
  // verdict here. Undefined for events that aren't tool results, and for
  // hook scripts predating this field.
  isError: z.boolean().optional(),
  prompt: z.string().optional(),
  stopReason: z.string().optional(),
  sessionId: z.string().optional(),
  source: z.string().optional(),
  // Path del JSONL donde Claude Code escribe la sesión que corre este run.
  // Es la única fuente de `usage` de un run de terminal: el CLI no lo
  // reporta por ningún otro canal, y `complete_task` lo llama el modelo, que
  // no conoce su propia cuenta de tokens. Lo manda cada hook que lo tiene.
  transcriptPath: z.string().optional(),
})
export type HookEvent = z.infer<typeof HookEventSchema>

// Legacy alias kept for backward compat — hook-events.ts was the only consumer
// and it has been updated to use HookEventSchema directly.
export const HookToolEventSchema = HookEventSchema
export type HookToolEvent = HookEvent

// ─── Remote Log Forwarding (logger.ts → another ia-flow server) ──────────
// Payload posted by a logger instance configured with IA_FLOW_REMOTE_LOG_URL
// (e.g. the headless refiner engine, see agents/functional-refiner/README.md) to
// `POST /api/remote-logs` on another ia-flow server. Re-emitted there via
// createLogger(module), so it lands in that server's own daemon.log and WS
// broadcast exactly like a line logged locally.
export const RemoteLogEntrySchema = z.object({
  level: ServerLogLevelSchema,
  module: z.string().min(1).max(200),
  msg: z.string().max(10_000),
  extras: z.record(z.string(), z.unknown()).optional(),
})
export type RemoteLogEntry = z.infer<typeof RemoteLogEntrySchema>

// ─── Remote Execution Log Forwarding (IExecutionLogRepository → another
// ia-flow server) ──────────────────────────────────────────────────────────
// Payload posted by RemoteExecutionLogRepository (a headless engine
// container composed with IA_FLOW_REMOTE_EXECUTIONS_URL, mirroring the
// logger's IA_FLOW_REMOTE_LOG_URL) to `POST /api/remote-executions` on
// another ia-flow server. Re-applied there against that server's own
// execution_logs table via the same insert/update the local repo would run.
export const RemoteExecutionLogEntrySchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('insert'), entry: ExecutionLogSchema }),
  z.object({ op: z.literal('update'), id: z.string(), patch: ExecutionLogSchema.partial() }),
])
export type RemoteExecutionLogEntry = z.infer<typeof RemoteExecutionLogEntrySchema>

// ─── Webhook status (GET /api/webhooks/status) ───────────────────────────
// Modo efectivo del daemon por proyecto — la UI lo muestra para responder
// "¿ya está escuchando webhooks o sigue haciendo pull?" (ver
// apps/web/src/features/webhook-status).
export const WebhookDaemonModeSchema = z.enum(['webhook', 'polling'])

export const WebhookProjectStatusSchema = z.object({
  projectId: z.string(),
  name: z.string(),
  mode: WebhookDaemonModeSchema,
  webhook: z
    .object({
      lastEventAt: z.string().nullable(),
      lastReason: z.string().nullable(),
      lastScanAt: z.string().nullable(),
      fallbackIntervalMs: z.number(),
      deliveryReceived: z.boolean(),
    })
    .nullable(),
})

export const WebhookStatusSchema = z.object({
  defaultMode: WebhookDaemonModeSchema,
  secretConfigured: z.boolean(),
  endpoint: z.string(),
  projects: z.array(WebhookProjectStatusSchema),
})
export type WebhookDaemonMode = z.infer<typeof WebhookDaemonModeSchema>
export type WebhookProjectStatus = z.infer<typeof WebhookProjectStatusSchema>
export type WebhookStatus = z.infer<typeof WebhookStatusSchema>

// ─── Integraciones opcionales ────────────────────────────────────────────────
//
// Qué sistemas externos puede usar ESTE proceso. Lo publica
// `GET /api/integrations` y lo consume la web para no ofrecer controles que no
// pueden funcionar: un picker de canales de Slack que siempre vuelve vacío
// parece un bug, y el operador no tiene forma de saber que falta un token.
//
// Cada integración declara `enabled` y, cuando está apagada, el `reason` — el
// motivo es lo que convierte "no anda" en algo accionable. Una integración
// nueva (Linear, Sentry) agrega su propia clave; no hay una lista genérica de
// flags porque cada una tiene las capacidades que tiene.
export const SlackIntegrationStatusSchema = z.object({
  /** Hay `SLACK_BOT_TOKEN`: se puede hablar (tools, directorio, review). */
  enabled: z.boolean(),
  /** Hay `SLACK_SIGNING_SECRET`: se puede escuchar (Events API entrante). */
  webhook: z.boolean(),
  reason: z.string().optional(),
  webhookReason: z.string().optional(),
})

export const IntegrationsStatusSchema = z.object({
  slack: SlackIntegrationStatusSchema,
})

export type SlackIntegrationStatus = z.infer<typeof SlackIntegrationStatusSchema>
export type IntegrationsStatus = z.infer<typeof IntegrationsStatusSchema>
