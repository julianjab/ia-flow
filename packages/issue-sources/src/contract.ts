import type { EventOutcome } from '@ia-flow/rules'
import type { CommentTarget, StatusConfig, Task, TaskComment } from '@ia-flow/shared'

export type { Task }

// ─── IssueItem — canonical shape of an item polled from a source, before it
// becomes a Task. Populated by ProjectSource.toIssueItem() and consumed by
// both the dispatch managers (loops) and TaskDispatcher (converts to Task via
// issueItemToTask below). ──────────────────────────────────────────────────

export interface IssueItem {
  id: string
  title: string
  description: string
  status: string
  type: string
  repos: string[]
  agentWorking?: boolean
  issueNumber?: number
  issueUrl?: string
  labels?: string[]
  assignees?: string[]
  comments?: TaskComment[]
  fields?: Record<string, string>
  nodeId?: string
  /**
   * Branch git canónica linkeada al issue (Development panel de GitHub).
   * Undefined si no hay linked branches; el engine puede auto-crear una si el
   * primer agente con write tools la necesita.
   */
  branch?: string
  /**
   * Provider-specific opaque metadata (issueId, projectId, issueBody, ...).
   * Consumers outside the source impl treat it as read-only.
   */
  meta?: Record<string, unknown>
  /** ia-flow project this item belongs to (stamped by the manager that fetched it). */
  projectId?: string
}

export interface ValidationResult {
  ok: boolean
  reason?: string
}

export type Disposable = { dispose(): void }

export type BroadcastFn = (msg: object) => void

export interface Blocker {
  /** Stable identifier of the blocking issue (source-native). */
  id: string
  /** Short label for logs/UI (e.g. `#42`, task filename). */
  ref?: string
  /** Human-readable title of the blocking issue if the source knows it. */
  title?: string
  /** Source-native status of the blocker (e.g. `open`, `Refine`). */
  status?: string
  /** Clickable link. GitHub: issue URL. Local: `vscode://file/<abs path>`. */
  url?: string
}

export function issueItemToTask(item: IssueItem): Task {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    status: item.status,
    type: (item.type as Task['type']) ?? 'functional',
    repos: item.repos,
    created_at: new Date().toISOString(),
    issueNumber: item.issueNumber,
    issueUrl: item.issueUrl,
    labels: item.labels,
    assignees: item.assignees,
    fields: item.fields,
    comments: item.comments,
    projectId: item.projectId,
    branch: item.branch,
  }
}

// ─── ITaskSource — write-side port that adapts task I/O primitives (status,
// fields, labels, comments, blockers, …) to the underlying project source
// (GitHub Projects, local YAML, …). Implementations live under
// `<source>/task-source.ts`. Consumed both by the agent-engine (via
// AgentLifecycle) and directly by tools that need a single primitive
// (set_task_field, set_task_labels, add_task_comment, …). ─────────────────

export interface PostErrorOptions {
  /** El fallo ya se publicó como comentario por `postComment`. */
  alreadyCommented?: boolean
}

/** A dónde se mueve una task. Lleva las COORDENADAS de GitHub y no sólo el
 *  nombre porque los dos no tienen por qué coincidir: `name` es el nombre local
 *  del repo en ia-flow (el del directorio) y `githubOwner`/`githubRepo` son los
 *  reales. Mandar el nombre local a la API apunta a `owner/<nombre-local>`, que
 *  o no existe o —peor— es otro repo homónimo. */
export interface TransferTarget {
  name: string
  githubOwner?: string
  githubRepo?: string
}

/** Coordenadas NUEVAS del issue después de un transfer — el número y el id
 *  cambian, así que quien lo pidió no puede seguir usando los que tenía. */
export interface TransferResult {
  repo: string
  issueNumber: number
  issueUrl: string
}

export interface ITaskSource {
  applyTransition(task: Task, newStatus: string): Promise<Task>
  saveOutput(task: Task, content: string): Promise<Task>
  setAgentWorking(task: Task, working: boolean): Promise<Task>
  /**
   * Registra el fallo del run en el source.
   *
   * `alreadyCommented` dice que el fallo YA quedó publicado en el timeline —
   * es lo que hace `fail_task`, que manda su propio comentario estructurado
   * por `postComment` antes de llamar acá. Las fuentes cuyo ÚNICO canal de
   * error es un comentario (las de GitHub: no hay campo de estado donde
   * dejarlo) lo saltean, para no dejar dos comentarios por el mismo fallo;
   * las que persisten estado aparte (local-fs escribe `task.error`, que es
   * lo que pinta el banner rojo de la UI) lo ignoran y guardan igual.
   */
  postError?(task: Task, error: string, opts?: PostErrorOptions): Promise<void>
  /**
   * Publica un comentario en la conversación de la task.
   *
   * `target` dice DÓNDE, y por qué existe: la regla es que un comentario vive
   * donde vive lo que el hallazgo cambia — si cambia qué hay que construir va
   * al issue, si critica cómo está escrito este código va al PR. Ausente ⇒
   * `pr-else-issue` (el default de `resolveCommentTarget`), que es lo correcto
   * para casi todo una vez que existe un PR y cae al issue solo cuando no hay
   * ninguno abierto.
   *
   * Un source sin noción de PRs (local-fs) puede ignorar el parámetro: todo va
   * a su único destino.
   */
  postComment?(task: Task, body: string, target?: CommentTarget): Promise<void>
  /** Returns project-level variables available as {{project.*}} in agent prompts. */
  getProjectContext?(): Record<string, string>
  /** Sets one or more project fields (non-status) in a single call. Persists to remote if supported. */
  setFields?(task: Task, fields: Record<string, string>): Promise<Task>
  /**
   * Reemplaza el set completo de labels de la task por `labels`.
   *
   * Es **reemplazo**, no agregado: es el único primitivo con el que se pueden
   * expresar las tres operaciones del DSL `$labels:` (+añadir / -quitar /
   * =reemplazar). Quien llama calcula el set final — ver `applyLabelOps` en
   * el engine. Un array vacío borra todas las labels.
   *
   * Los sources que no modelan labels nativamente (p. ej. LocalProjectSource)
   * pueden tratarlo como no-op.
   */
  setLabels?(task: Task, labels: string[]): Promise<Task>
  /**
   * Marks `blockedIssueId` as blocked by `blockingIssueId` (source-native
   * dependency relationship). IDs are opaque to the domain — each adapter
   * decides the format (node ID, numeric ID, etc.).
   */
  markBlockedBy?(task: Task, blockedIssueId: string, blockingIssueId: string): Promise<void>
  /**
   * Returns source-specific context needed by adapter-owned tools (e.g. the
   * GitHub adapter tools use this to reach the current project item). The
   * shape is opaque to the domain — only the adapter's own tools know how
   * to interpret it.
   */
  getSourceToolContext?(): unknown
  /**
   * Fresh read of the task's current Status **bypassing any in-memory or
   * TTL cache** in the adapter. Used by orchestration guards that must not
   * trust stale in-process copies of the task (e.g. deciding whether the
   * prompt already moved the task before applying the default onFinish).
   * Return null if the source doesn't expose a status.
   */
  getCurrentStatus?(task: Task): Promise<string | null>
  /**
   * Devuelve el ID canónico del issue en el source y las coordenadas del repo
   * primario, si el source los conoce (típicamente GitHub). Lo usa el
   * orquestador para auto-crear una linked branch en el Development panel
   * cuando el primer agente con write tools se lanza y `task.branch` está
   * vacío. `null` cuando el source no lo soporta (ej. adapter local).
   */
  getLinkedBranchRef?(task: Task): { issueNodeId: string; owner: string; repoName: string } | null
  /**
   * Mueve la task a otro repositorio del source.
   *
   * Existe porque el repo de una task NO es un dato que se pueda corregir
   * escribiendo un campo: en `github-project` sale del `Repository` nativo del
   * issue (ver `resolveRepos`), así que la única forma de re-rutear una tarea
   * mal ubicada es mover el issue de verdad. Un agente que descubre —
   * explorando— que el trabajo vive en otro repo llama a `transfer_task_repo`,
   * y esto es lo que la tool necesita del source.
   *
   * **El run termina cuando esto vuelve.** El transfer cambia el número y el
   * id del issue, así que todo lo que el prompt ya renderizó (`{{task.repos}}`,
   * `{{task.issueUrl}}`, el número) queda viejo: seguir trabajando sería operar
   * sobre coordenadas muertas. El próximo scan re-despacha la task con el repo
   * correcto y el prompt correcto.
   *
   * Opcional: un source sin noción de repos (local-fs) simplemente no lo
   * implementa y la tool se rechaza con el motivo.
   */
  transferToRepo?(task: Task, target: TransferTarget): Promise<TransferResult>
  /**
   * Mark comments as read — see IIssueManager.markCommentsUsed. TaskDispatcher
   * attaches the underlying IIssueManager's implementation onto the
   * per-item TaskSource it hands to Agent.run, so the mark can happen from
   * inside `run` — after the provider genuinely consumed the prompt, using
   * the FINAL agentDef (post re-selection), not the one TaskDispatcher
   * matched before dispatch commits.
   */
  markCommentsUsed?(comments: Array<{ id: string; body: string }>): Promise<void>
}

/** Back-compat alias — most files historically imported this as `TaskSource`. */
export type TaskSource = ITaskSource

// ─── IIssueManager — the polling/dispatch loop contract. ───────────────────

export interface IIssueManager {
  /** A qué proyecto pertenece. Lo necesita quien suscribe al manager al bus de
   *  eventos: los handlers filtran por `scope.projectId`, y antes eso lo
   *  garantizaba el cableado directo manager→dispatcher. */
  readonly projectId: string
  // Ver DispatchOutcome más abajo: `void` sigue siendo válido para un manager
  // al que no le interesa la capacidad; sólo SourceDispatcher lee el valor.
  start(dispatch: (item: IssueItem) => Promise<DispatchOutcome | undefined>): Disposable
  getTransitionManager(item: IssueItem): ITaskSource
  validate?(item: IssueItem): Promise<ValidationResult>
  /**
   * Report whether the underlying source is set up for the daemon to work.
   * When present and returns `{ ok: false }`, PollingIssueManager skips poll
   * cycles and TaskDispatcher skips dispatch as a safety net. Absent = ok.
   * Return shape matches ProjectSource.getHealth().
   */
  getHealth?(): Promise<{
    ok: boolean
    missing: Array<{ name: string; purpose: string }>
    warnings: Array<{ name: string; purpose: string }>
    message?: string
  }>
  /**
   * Return unfinished blockers (issues this item depends on that are not yet
   * done). Source-native definition of "finished":
   * - GitHub: issue.state !== 'closed'
   * - Local: blocker task's status !== 'Done' (case-insensitive)
   * Absent implementations behave as "no blockers".
   */
  getBlockers?(item: IssueItem): Promise<Blocker[]>
  /**
   * Load issue comments right before dispatch so `{{task.comments}}` renders
   * in agent prompts. Absent = source has no notion of comments.
   */
  loadComments?(item: IssueItem): Promise<TaskComment[]>
  /**
   * Mark comments as read so they don't get re-loaded (and re-injected into
   * `{{task.comments}}`) on every future dispatch of the same item — called
   * by TaskDispatcher right after loadComments. Best-effort: absent = source
   * has no notion of comments, or doesn't support marking (comments keep
   * showing up on every run, same as before this existed).
   */
  markCommentsUsed?(comments: Array<{ id: string; body: string }>): Promise<void>
}

// ─── ProjectSource — abstraction over a project's issue provider. ─────────
//
// Used by both:
//   · REST layer (/api/projects/:id/source/*) for UI reads.
//   · The daemon's dispatch managers, which fetch getItems() and delegate
//     write-side per-item concerns (status transitions, working flag,
//     comments, saveOutput) to source-provided TaskSources.
//
// Adding a new provider (Linear, Jira, ...): implement `ProjectSource` in a
// new file under this package, register it in the host's source registry.
// No route, no manager subclass, no factory.

export interface StatusOption {
  name: string
  // Optional colour/description if the provider exposes it (github does not).
  description?: string
}

// A field exposed by the underlying provider (GitHub Project v2 column, Linear
// custom field, …). The UI uses this to build condition editors that reference
// any project field, not just Status.
export interface SourceProjectField {
  name: string
  // Provider-native type. GitHub Project v2 emits `SINGLE_SELECT` | `TEXT` |
  // `NUMBER` | `DATE` | `ITERATION`. Other providers keep their own strings —
  // the web treats it as opaque.
  dataType: string
  // Populated for enum-like fields (SINGLE_SELECT). Empty otherwise.
  options?: string[]
}

export interface SourceItem {
  id: string
  title: string
  status: string
  repos?: string
  // Navigable link to the item in the provider's UI. GitHub → deep-link to
  // the draft on the project board. Local → vscode://file/<abs path>. Absent
  // when the provider can't produce one.
  url?: string
  // Free-form provider-specific metadata — routes/UI treat this as opaque.
  meta?: Record<string, unknown>
}

// Write-side payloads for provider-agnostic task mutations (POST/PUT/DELETE
// /api/tasks). Every field is optional except title on create; providers apply
// whatever they can represent and silently ignore the rest.
export interface CreateItemInput {
  title: string
  description?: string
  type?: 'functional' | 'technical'
  repos?: string[]
  status?: string
  // GitHub Projects only: false creates a real issue in `repos[0]` (owned by
  // the project's org) and adds it to the board, instead of a project-only
  // draft issue. Default true (draft) — other providers ignore this, they
  // already create real issues unconditionally.
  draft?: boolean
}

export interface UpdateItemInput {
  title?: string
  description?: string
  type?: 'functional' | 'technical'
  repos?: string[]
  status?: string
}

/** Subset of a webhook delivery a source can route on. See webhook-registry. */
export interface WebhookMatchHint {
  projectNodeId?: string
  repoFullName?: string
  event?: string
  deliveryId?: string
}

export interface SourceHealthField {
  name: string
  purpose: string
}

export interface SourceHealth {
  ok: boolean
  // Fields the daemon requires. Any entry here → ok=false.
  missing: SourceHealthField[]
  // Fields that are optional but recommended (e.g. Repos for context).
  warnings: SourceHealthField[]
  // Free-form human message. Empty on healthy sources.
  message?: string
}

/**
 * Runtime knobs for `ProjectSource.watch()`. `mode` is still an operator
 * decision (per-project `daemonMode` — see daemon-mode.ts), but the
 * *mechanism* behind each mode (a timer vs a webhook subscription) is now the
 * source's own concern, not the caller's. The interval/debounce/fallback
 * knobs stay caller-supplied so env-var resolution keeps living outside the
 * source (same lazy-read pattern as today's `pollIntervalMs()`/
 * `webhookDebounceMs()`).
 */
export interface WatchOptions {
  /** ia-flow's own project id — sources in `mode: 'webhook'` need it to
   *  register a WebhookTarget (webhook-registry.ts is keyed by this, not by
   *  anything the provider knows). Ignored by sources with no webhook
   *  transport (e.g. local-fs's fs watcher). */
  projectId: string
  mode: 'webhook' | 'polling'
  /** `mode: 'polling'` only — ms between fetch ticks. */
  intervalMs?: number
  /** `mode: 'webhook'` only — coalescing window, keyed per changed item id. */
  debounceMs?: number
  /** `mode: 'webhook'` only — optional periodic full-scan safety net. `0`/absent = off. */
  fallbackMs?: number
  /** Surfaced to the caller's logger instead of thrown — `watch()` must not crash the daemon. */
  onError?: (err: unknown) => void
}

export interface ProjectSource {
  /** Stable id of the source impl — used by the registry, not shown to users. */
  readonly kind: string

  /** Field options for the project (statuses, types, etc.). */
  getStatuses(opts?: { refresh?: boolean }): Promise<StatusOption[]>

  /**
   * All fields exposed by the provider, so the UI can build condition editors
   * that reference any field (Status, Priority, custom fields, …). Sources
   * that only surface a Status field can omit this — callers fall back to a
   * synthetic Status field derived from getStatuses().
   */
  getFields?(opts?: { refresh?: boolean }): Promise<SourceProjectField[]>

  /** Items currently in the project, optionally filtered by status. */
  getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]>

  /** Update a scalar field on a single item. Not all providers support all fields. */
  setItemField?(itemId: string, field: string, value: string): Promise<void>

  /**
   * Persiste el link del hilo de Slack donde se pidió review de esta tarea.
   *
   * **Dónde vive es decisión de la fuente**, no del que pide el review: un
   * board de Projects tiene un campo de texto, un repo suelto sólo tiene el
   * cuerpo del PR, local-fs tiene una sección del YAML. Un lugar fijo obligaría
   * a las fuentes sin ese soporte a inventarlo, y guardarlo en dos lados
   * obligaría a decidir cuál gana cuando discrepan.
   *
   * Ausente ⇒ la fuente no sabe recordarlo: el pedido de review se publica
   * igual, pero cada uno abre un hilo nuevo en vez de continuar el anterior.
   */
  setSlackThreadUrl?(item: IssueItem, url: string): Promise<void>

  /**
   * La contracara de `setSlackThreadUrl`: el link guardado, o `undefined` si
   * esta tarea todavía no pidió review. Es lo que decide "primer review" vs
   * "re-review".
   *
   * Es **async** porque no toda fuente puede leerlo gratis: un campo del board
   * ya viene en el item, pero un link guardado en el cuerpo del PR necesita un
   * request. Se llama una vez por pedido de review, no por scan.
   *
   * Cuando la fuente SÍ puede resolverlo sin I/O, además lo publica en
   * `SourceItem.meta.slackThreadUrl`, que es lo que la web usa para dibujar el
   * tag del hilo en la tarjeta sin llamar a nada.
   */
  getSlackThreadUrl?(item: IssueItem): Promise<string | undefined>

  /**
   * Create a new item in the underlying provider. Sources that can't create
   * items (read-only mirrors) omit this — the route responds with 501.
   * Returns the created item so the caller can echo id/status back.
   */
  createItem?(input: CreateItemInput): Promise<SourceItem>

  /**
   * Patch an existing item. Only the fields present in `patch` change;
   * omitted fields are left untouched.
   */
  updateItem?(id: string, patch: UpdateItemInput): Promise<SourceItem>

  /** Remove an item from the provider. */
  deleteItem?(id: string): Promise<void>

  /**
   * Build a per-item TaskSource (the write side used by the agent-engine to
   * apply status transitions, mark working, post comments, save output).
   * Sources that don't drive an active work loop (e.g. LocalProjectSource used
   * only from the UI) can omit this — the daemon skips them.
   */
  getTransitionManager?(item: IssueItem, broadcast: BroadcastFn): TaskSource

  /**
   * Convert a fetched SourceItem into the daemon-facing IssueItem shape.
   * Default (see helper below) copies the common fields — override when the
   * provider needs to stash extra metadata for its TaskSource.
   */
  toIssueItem?(item: SourceItem): IssueItem

  /**
   * Load the item's conversation. Called by the daemon right before dispatch
   * so `{{task.comments}}` is populated in agent prompts. Absence = source has
   * no notion of comments (they render as empty).
   *
   * "Conversation" is deliberately wider than "issue comments": the GitHub
   * sources also return the comments and unresolved review threads of the
   * item's OPEN pull requests, tagged via `TaskComment.origin`. Half the
   * pipeline's findings live on the PR, so a reader limited to the issue
   * cannot answer "what happened since my last run?".
   */
  loadComments?(item: IssueItem): Promise<TaskComment[]>

  /**
   * Mark comments as read — see IIssueManager.markCommentsUsed. SourceDispatcher
   * passes this straight through.
   */
  markCommentsUsed?(comments: Array<{ id: string; body: string }>): Promise<void>

  /**
   * Optional startup hook — e.g. reset stuck "working" flags on crash recovery.
   * Called once by the daemon before the first poll.
   */
  onDaemonStart?(): Promise<void>

  /**
   * Webhook mode only: decide whether an incoming provider delivery concerns
   * this source, so a push event only wakes the projects it actually touches.
   * Absence = "match everything" (the daemon scans on every delivery, which is
   * correct but chattier). Implementations should also return true when they
   * can't tell — a spurious scan is cheaper than a dropped event.
   */
  matchesWebhook?(hint: WebhookMatchHint): Promise<boolean>

  /**
   * Diagnose whether this source has everything it needs for the daemon to
   * poll and drive transitions. Fields the daemon relies on (Status,
   * Working, …) surface as either `missing` (breaks polling / correctness)
   * or `warnings` (works but degraded).
   */
  getHealth?(): Promise<SourceHealth>

  /**
   * Return unfinished blockers for `item`. Absence = source doesn't model
   * dependencies (behaves as "no blockers"). Implementations decide what
   * counts as "unfinished":
   *   · GitHub — issue.state !== 'closed'
   *   · Local  — blocker task status !== 'Done' (case-insensitive)
   */
  getBlockers?(item: IssueItem): Promise<Blocker[]>

  /**
   * Fetch a single item by its source-native ID, via a direct lookup (not a
   * linear scan over getItems()) — used both by REST endpoints resolving an
   * id from URL params, and by DivergenceReconciler to re-check exactly the
   * items with a `pending` agent run, without paying for a full list fetch.
   * Absence = callers fall back to getItems() (accepted as source-specific
   * debt, not the default expectation — see individual source docs).
   */
  getItemById?(id: string): Promise<SourceItem | null>

  /**
   * Fetch a single item by its underlying ISSUE's native ID, when the
   * source distinguishes the issue from the "item" (e.g. GitHub Projects:
   * a ProjectV2Item wraps an Issue under a DIFFERENT node id). Needed
   * because `issue_comment`/`issues` webhooks only carry the Issue's node
   * id — GitHub never includes the ProjectV2Item id on those payloads — so
   * `getItemById` (which expects THAT id) can't resolve them. Absence =
   * callers accept the event without a resolved `item` (see
   * IWebhookTranslator.resolveItem's doc); for a source where the issue
   * IS the item (github-issues, local) this is redundant with
   * `getItemById` and doesn't need implementing.
   */
  getItemByIssueId?(issueId: string): Promise<SourceItem | null>

  /**
   * Push-based watch: the source owns HOW it learns about changes (an
   * internal poll timer, a webhook-registry subscription, an fs watcher,
   * whatever fits its transport) and emits fully-resolved SourceItems as it
   * detects them — never bare ids. Replaces the old design where a generic
   * dispatch manager decided the fetch strategy and always re-listed the
   * whole backlog.
   *
   * `onItems` may be called with a batch of 1 (the common webhook case) or
   * many (a full re-scan, e.g. on the boot catch-up or a coalesced burst
   * touching several items). The caller (SourceDispatcher) treats every
   * batch identically — there is no separate "list" code path.
   *
   * Divergence reconciliation (comparing status of in-flight `pending` tasks
   * against the source) is NOT this method's job — it's a source-agnostic
   * concern that lives in DivergenceReconciler, driven by getItemById, and
   * runs independently of whether watch() ever emits anything.
   *
   * Required — all three shipped sources (github-issues, github-project,
   * local-fs) implement it; SourceDispatcher (dispatch/source-dispatcher.ts)
   * is the sole caller.
   */
  watch(onItems: (items: SourceItem[]) => void, opts: WatchOptions): Disposable
}

/**
 * Default SourceItem → IssueItem mapping. Providers that need extra data in
 * `meta` (issueId, issueNumber, ...) override toIssueItem() themselves.
 */
export function defaultToIssueItem(item: SourceItem): IssueItem {
  return {
    id: item.id,
    title: item.title,
    description: '',
    type: (item.meta?.type as string) ?? '',
    repos: item.repos
      ? item.repos
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : [],
    status: item.status,
    agentWorking: item.meta?.working === true,
    meta: item.meta,
  }
}

// ─── DB-backed ports consumed by dispatch managers / sources. Concrete
// (SQLite) implementations stay in apps/server; only the shape lives here. ─

export interface IStatusRepository {
  list(projectId?: string): StatusConfig[]
  getByName(projectId: string, name: string): StatusConfig | null
  upsert(status: StatusConfig, position: number, projectId: string): void
  deleteByName(projectId: string, name: string): void
  clearScope(projectId: string): void
}

// Filesystem-backed task store. Each task is a single YAML file grouped
// by status into subdirectories under a well-known root (see local-fs for
// the concrete adapter).
export interface ITaskRepository {
  // Absolute path to the tasks root — the local file-watcher issue-manager
  // watches it directly.
  root(): string
  read(filePath: string): Promise<Task | null>
  save(task: Task): Promise<void>
  listAll(): Promise<Task[]>
  getById(id: string): Promise<Task | null>
  move(task: Task, newStatus: string): Promise<Task>
  update(task: Task): Promise<void>
  delete(id: string): Promise<void>
  listStatuses(): Promise<string[]>
}

// ─── Pending-task registry port ────────────────────────────────────────────
//
// The real registry (`@ia-flow/agent-engine`'s `PendingTaskRegistry`) is a
// module-level singleton — it tracks in-flight agent runs across the whole
// app, not just issue-sources. SourceIssueManager only needs to *read* it
// (skip items already dispatched, cancel ones whose status drifted), so it
// depends on
// this narrow port instead of importing the singleton module directly.

export interface PendingTaskInfo {
  task: Pick<Task, 'projectId'>
  // Frozen at dispatch — see the full doc on this field in
  // packages/agent-engine/src/pending-tasks.ts (PendingTask.initialStatus).
  // Divergence reconciliation should prefer `reconciliationStatus` instead.
  initialStatus: string
  // Resynced when the agent itself moves the task's status mid-run (see
  // PendingTask.reconciliationStatus) — falls back to `initialStatus` when
  // unset. This is what SourceIssueManager's divergence loop should compare
  // the source's live status against.
  reconciliationStatus?: string
  /** Presente ⇒ esta entrada es un sub-agente lanzado con `run_agent`, no un
   *  dispatch propio. Lo lee el cap del proyecto para no contarlo: ese cap
   *  limita cuántos ISSUES se trabajan a la vez, y un hijo es más trabajo
   *  sobre uno ya contado. Ver `PendingTask.parentRunId` en
   *  @ia-flow/agent-engine para por qué contarlo produce deadlock. */
  parentRunId?: string
  cancel?: () => Promise<void>
}

/**
 * Qué pasó con un item que se le entregó al dispatcher.
 *
 *   dispatched → el agente arrancó (o al menos llegó a la llamada al provider)
 *   skipped    → no había nada que correr para este item: no matcheó ningún
 *                agente, está bloqueado, la fuente está degradada, … —
 *                reintentar YA no cambia el resultado, así que el item se
 *                suelta y vuelve por el próximo batch.
 *   deferred   → había trabajo pero no capacidad (cap de agente o todos los
 *                providers candidatos saturados). El item vuelve al backlog y
 *                se replaya cuando se libere un slot, SIN volver a pegarle a
 *                la fuente.
 *
 * La distinción skipped/deferred es la razón de ser de este tipo: antes todo
 * el camino devolvía `void`/`boolean` y un dispatch que no pudo correr por
 * capacidad se perdía silenciosamente hasta el próximo poll.
 *
 * Aliasea `EventOutcome` de `@ia-flow/rules`: cuando el dispatch pasó a viajar
 * por el bus de eventos, el resultado de despachar un item y el de publicar un
 * evento se volvieron el mismo concepto. Mantenerlos como dos tipos con el
 * mismo shape sería una forma silenciosa de que uno gane un caso que el otro no
 * maneja.
 */
export type DispatchOutcome = EventOutcome

export interface PendingTaskRegistryPort {
  getPendingTask(taskId: string): unknown
  listPendingTasks(): Array<[string, PendingTaskInfo]>
  removePendingTask(
    taskId: string,
    finish?: { cancelled?: boolean; finalizedByTool?: boolean },
  ): void
}
