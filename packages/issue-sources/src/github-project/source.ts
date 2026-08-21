import { invalidateMemoized, memoize, peekMemoized } from '@ia-flow/shared'
import type {
  BroadcastFn,
  CreateItemInput,
  Disposable,
  IssueItem,
  ProjectSource,
  SourceHealth,
  SourceItem,
  SourceProjectField,
  StatusOption,
  TaskSource,
  UpdateItemInput,
  WatchOptions,
  WebhookMatchHint,
} from '../contract.js'
import { MULTI_SELECT_DATA_TYPE } from '../dispatch/field-ops.js'
import { pollingWatch, webhookWatch } from '../dispatch/watch-helpers.js'
import type { WebhookDelivery } from '../dispatch/webhook-registry.js'
import {
  createIssue,
  fetchIssueComments,
  getBlockingIssues,
  markCommentsUsed as markIssueCommentsUsed,
} from '../github-shared/issue.js'
import { createLogger } from '../logger.js'
import {
  type ProjectItem,
  type ProjectMeta,
  addProjectItem,
  clearItemWorking,
  createProjectDraftIssue,
  deleteProjectItem,
  getProjectItemById,
  getProjectMeta,
  listProjectItems,
  setProjectTextField,
  updateItemStatus,
  updateProjectDraftIssue,
} from './api/project.js'
import { GitHubTaskSource } from './task-source.js'

const log = createLogger('github-project-source')

// Meta stays fresh for 5 min, items for 1 min — matches the TTLs the routes
// used before and avoids hammering GitHub when two projects live in
// different tabs of the same user session. Each GitHubProjectSource
// instance is already scoped to one URL (constructor arg), so `@memoize`
// caches per instance — no manual per-URL Map needed. `key: () => '...'`
// pins one cache slot per instance regardless of the `refresh` arg;
// `bypass` is what actually forces a refetch. See @ia-flow/shared/cache.ts.
const META_TTL_MS = 5 * 60 * 1000
const ITEMS_TTL_MS = 60 * 1000
const META_KEY = 'meta'
const bypassOnRefresh = (opts?: { refresh?: boolean }) => opts?.refresh === true

/**
 * Labels distintas presentes en un set de items, ordenadas alfabéticamente.
 * Pura y exportada para poder testearla sin red: alimenta las `options` del
 * pseudo-campo `Labels` que consume el multiselect de la UI.
 */
export function collectLabels(items: Array<{ meta?: unknown }>): string[] {
  const seen = new Set<string>()
  for (const item of items) {
    const labels = (item.meta as { labels?: unknown } | undefined)?.labels
    if (Array.isArray(labels)) {
      for (const l of labels) if (typeof l === 'string' && l) seen.add(l)
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export class GitHubProjectSource implements ProjectSource {
  readonly kind = 'github'

  constructor(private readonly url: string) {}

  @memoize({ ttlMs: META_TTL_MS, key: () => META_KEY, bypass: bypassOnRefresh })
  private loadMeta(opts?: { refresh?: boolean }): Promise<ProjectMeta> {
    return getProjectMeta(this.url)
  }

  @memoize({ ttlMs: ITEMS_TTL_MS, key: () => 'items', bypass: bypassOnRefresh })
  private async fetchItems(opts?: { refresh?: boolean }): Promise<SourceItem[]> {
    const meta = await this.loadMeta(opts)
    const raw = await listProjectItems(meta.projectId, meta.fields)
    return raw.map((it) => this.toSourceItem(it, meta))
  }

  // Shared by fetchItems() (bulk) and getItemById() (single node(id) lookup)
  // so the two never map ProjectItem→SourceItem differently.
  private toSourceItem(it: ProjectItem, meta: ProjectMeta): SourceItem {
    return {
      id: it.id,
      title: it.issueTitle,
      status: it.status,
      repos: it.repos,
      // Everything the daemon's TaskSource needs later goes here —
      // consumers treat this blob as opaque.
      meta: {
        issueId: it.issueId,
        issueNumber: it.issueNumber,
        repoName: it.repoName,
        type: it.type,
        priority: it.priority,
        size: it.size,
        working: it.working,
        issueBody: it.issueBody,
        issueUrl: `https://github.com/${meta.owner}/${it.repoName}/issues/${it.issueNumber}`,
        labels: it.labels,
        assignees: it.assignees,
        fields: it.fields,
        // The GitHub Project v2 node id (used by the transition manager).
        ghProjectId: meta.projectId,
        owner: meta.owner,
        linkedBranch: it.linkedBranch,
      },
    }
  }

  async getStatuses(opts?: { refresh?: boolean }): Promise<StatusOption[]> {
    const meta = await this.loadMeta(opts)
    const statusField = meta.fields.Status
    if (!statusField?.options) return []
    return statusField.options.map((o) => ({ name: o.name }))
  }

  async getFields(opts?: { refresh?: boolean }): Promise<SourceProjectField[]> {
    const meta = await this.loadMeta(opts)
    // meta.fields is keyed by name, and getProjectMeta only stores nodes whose
    // GraphQL inline fragments matched (ProjectV2Field / SingleSelectField).
    // Built-in ProjectV2 fields (Assignees, Labels, Repository) don't match
    // those fragments so they aren't in meta.fields. Expose them as pseudo
    // fields so the condition editor can select them — evalCondition already
    // aliases these names to the corresponding Task keys.
    const custom = Object.values(meta.fields).map((f) => ({
      name: f.name ?? '',
      dataType: f.dataType ?? 'TEXT',
      options: f.options?.map((o) => o.name),
    }))
    // `Labels` viene con las opciones que ya se vieron en los items del
    // proyecto. No es el catálogo completo del repo — una label definida pero
    // nunca usada no aparece — pero sale del cache de items, sin ninguna
    // request extra, y cubre el caso real (elegir entre las labels que el
    // equipo efectivamente usa). Los editores que la consumen permiten escribir
    // una label nueva a mano, así que no tener el catálogo completo no bloquea.
    const builtins: SourceProjectField[] = [
      { name: 'Repository', dataType: 'TEXT' },
      {
        name: 'Labels',
        // MULTI_SELECT, no TEXT: es el campo que `setFields` resuelve con
        // operaciones con signo (`+a,-b`) en vez de asignar. El editor de
        // outcomes lee este dataType para ofrecer tokens en vez de un valor
        // suelto — declararlo TEXT dejaba al usuario escribiendo un valor
        // que el runtime iba a interpretar como ops igual.
        dataType: MULTI_SELECT_DATA_TYPE,
        options: await this.#knownLabels(opts?.refresh),
      },
      { name: 'Assignees', dataType: 'TEXT' },
    ]
    return [...custom, ...builtins]
  }

  /** Labels distintas presentes en los items del proyecto, ordenadas alfabéticamente. */
  async #knownLabels(refresh?: boolean): Promise<string[]> {
    try {
      return collectLabels(await this.getItems({ refresh }))
    } catch {
      // El catálogo es una comodidad para la UI: si la fuente falla, devolver
      // el campo sin opciones es mejor que romper todo `getFields`.
      return []
    }
  }

  async getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]> {
    let items = await this.fetchItems({ refresh: opts?.refresh })
    if (opts?.status) items = items.filter((i) => i.status === opts.status)
    return items
  }

  /** Direct GraphQL node(id) lookup (getProjectItemById) — not a scan over
   * the cached getItems() list. Warms meta first, same requirement watch()
   * has (see loadMeta()'s doc on getTransitionManager's peekMemoized read). */
  async getItemById(id: string): Promise<SourceItem | null> {
    const meta = await this.loadMeta()
    const it = await getProjectItemById(id)
    return it ? this.toSourceItem(it, meta) : null
  }

  // ─── Write side (task CRUD via provider) ────────────────────────────────

  async createItem(input: CreateItemInput): Promise<SourceItem> {
    const meta = await this.loadMeta()
    const body = buildDraftBody(input)
    const baseMeta = { type: input.type, ghProjectId: meta.projectId, owner: meta.owner }

    let itemId: string
    let url: string
    let itemMeta: Record<string, unknown>

    if (input.draft === false) {
      const repoName = input.repos?.[0]
      if (!repoName) {
        throw new Error(
          'draft:false requires at least one repo in "repos" — used as the target repository',
        )
      }
      // repoName is caller-controlled (POST /api/tasks body) and gets
      // interpolated straight into a GitHub REST path — reject anything that
      // isn't a bare repo name segment (no "/", "..", etc.) before it can
      // redirect the request to an arbitrary API path using our token.
      if (!/^[\w.-]+$/.test(repoName)) {
        throw new Error(`Invalid repo name '${repoName}' — must match [\\w.-]+`)
      }
      const issue = await createIssue(meta.owner, repoName, input.title, body)
      try {
        const added = await addProjectItem(meta.projectId, issue.id)
        itemId = added.itemId
      } catch (err) {
        // The issue itself is already created and live on GitHub at this
        // point — log its ref so it isn't silently orphaned off the board.
        log.error(
          { err, owner: meta.owner, repo: repoName, issueNumber: issue.number, url: issue.url },
          'Issue created but addProjectItem failed — issue exists but is not on the board',
        )
        throw err
      }
      url = issue.url
      itemMeta = { ...baseMeta, issueNumber: issue.number }
    } else {
      const created = await createProjectDraftIssue(meta.projectId, input.title, body)
      itemId = created.itemId
      url = `${this.url}?pane=issue&itemId=${created.databaseId}`
      itemMeta = { ...baseMeta, draftIssueId: created.draftIssueId, databaseId: created.databaseId }
    }

    await this.applyFields(meta, itemId, input)
    invalidateMemoized(this, 'fetchItems')
    const status = input.status ?? ''
    return {
      id: itemId,
      title: input.title,
      status,
      repos: input.repos?.join(', '),
      url,
      meta: itemMeta,
    }
  }

  async updateItem(id: string, patch: UpdateItemInput): Promise<SourceItem> {
    const meta = await this.loadMeta()
    const current = await this.getItemById(id)
    if (!current) throw new Error(`Item '${id}' not found in project`)
    const draftIssueId = current.meta?.draftIssueId as string | undefined
    if (patch.title !== undefined || patch.description !== undefined) {
      if (!draftIssueId) {
        throw new Error(
          `Item '${id}' is not a draft issue — cannot edit title/description via this endpoint`,
        )
      }
      const body =
        patch.description !== undefined
          ? buildDraftBody({
              description: patch.description,
              type: patch.type ?? (current.meta?.type as CreateItemInput['type']),
              repos:
                patch.repos ??
                (current.repos ? current.repos.split(',').map((r) => r.trim()) : undefined),
            })
          : undefined
      await updateProjectDraftIssue(draftIssueId, {
        ...(patch.title !== undefined && { title: patch.title }),
        ...(body !== undefined && { body }),
      })
    }
    await this.applyFields(meta, id, patch)
    invalidateMemoized(this, 'fetchItems')
    const refreshed = await this.getItemById(id)
    return refreshed ?? current
  }

  async deleteItem(id: string): Promise<void> {
    const meta = await this.loadMeta()
    await deleteProjectItem(meta.projectId, id)
    invalidateMemoized(this, 'fetchItems')
  }

  // Set optional project fields (Type / Repos / Status) after create/update.
  // Missing fields on the project are ignored (draft has no Repository field
  // anyway); status errors surface because that field is required.
  private async applyFields(
    meta: ProjectMeta,
    itemId: string,
    patch: { type?: string; repos?: string[]; status?: string },
  ): Promise<void> {
    if (patch.type) {
      const typeField = meta.fields.Type
      if (typeField) await setProjectTextField(meta.projectId, itemId, typeField, patch.type)
    }
    if (patch.repos !== undefined) {
      const reposField = meta.fields.Repos
      if (reposField) {
        await setProjectTextField(meta.projectId, itemId, reposField, patch.repos.join(', '))
      }
    }
    if (patch.status) {
      const statusField = meta.fields.Status
      if (statusField) await updateItemStatus(meta.projectId, itemId, statusField, patch.status)
    }
  }

  async setItemField(itemId: string, field: string, value: string): Promise<void> {
    const meta = await this.loadMeta()
    const f = meta.fields[field]
    if (!f) throw new Error(`Field '${field}' not found in project`)
    await setProjectTextField(meta.projectId, itemId, f, value)
    // Any mutation invalidates the items cache — statuses (meta) are unchanged.
    invalidateMemoized(this, 'fetchItems')
  }

  // ─── Daemon-facing (used by PollingIssueManager) ────────────────────────

  toIssueItem(item: SourceItem): IssueItem {
    const meta = item.meta ?? {}
    const rawBody = (meta.issueBody as string | undefined) ?? ''
    // Body may embed prior AI history separated by "\n\n---\n\n" — the daemon
    // wants only the human-authored top block.
    const description = rawBody.split('\n\n---\n\n')[0].trim()
    return {
      id: item.id,
      title: item.title,
      description,
      type: ((meta.type as string) ?? '').toLowerCase(),
      // Repo resolution order: custom "Repos" field (multi/refined) → built-in
      // Repository (single, source-native). Issues that already live in their
      // target repo don't need the custom Repos field set; the built-in
      // Repository gives us the primary repo out of the box. The refiner still
      // narrows this via `set_task_field` when converting an inbox issue into
      // a specific repo (or splits into sub-issues for an epic).
      repos: resolveRepos(item.repos, meta.repoName as string | undefined),
      status: item.status,
      agentWorking: meta.working === true,
      issueNumber: meta.issueNumber as number | undefined,
      issueUrl: meta.issueUrl as string | undefined,
      labels: (meta.labels as string[] | undefined) ?? [],
      assignees: (meta.assignees as string[] | undefined) ?? [],
      fields: (meta.fields as Record<string, string> | undefined) ?? {},
      // Branch linkeada al issue vía Development panel — poblada por
      // listProjectItems (`linkedBranches`). Undefined si no hay ninguna.
      branch: (meta.linkedBranch as string | undefined) ?? undefined,
      meta,
    }
  }

  async loadComments(
    item: IssueItem,
  ): Promise<Array<{ id: string; body: string; created_at: string }>> {
    const issueId = (item.meta?.issueId as string | undefined) ?? undefined
    if (!issueId) return []
    try {
      const raw = await fetchIssueComments(issueId)
      return raw.map((c) => ({ id: c.id, body: c.body, created_at: c.created_at }))
    } catch (err) {
      log.warn(
        { url: this.url, issueId, err: (err as Error).message },
        'loadComments failed — returning empty',
      )
      return []
    }
  }

  async markCommentsUsed(comments: Array<{ id: string; body: string }>): Promise<void> {
    await markIssueCommentsUsed(comments)
  }

  async getBlockers(item: IssueItem) {
    const m = item.meta ?? {}
    const repoName = (m.repoName as string | undefined) ?? undefined
    const issueNumber = (m.issueNumber as number | undefined) ?? item.issueNumber
    if (!repoName || issueNumber == null) return []
    const meta = await this.loadMeta().catch(() => null)
    if (!meta) return []
    try {
      const blockers = await getBlockingIssues(meta.owner, repoName, issueNumber)
      return blockers
        .filter((b) => b.state !== 'closed')
        .map((b) => ({
          id: `${meta.owner}/${repoName}#${b.number}`,
          ref: `#${b.number}`,
          title: b.title,
          status: b.state,
          url: `https://github.com/${meta.owner}/${repoName}/issues/${b.number}`,
        }))
    } catch (err) {
      log.warn(
        { url: this.url, issueNumber, err: (err as Error).message },
        'getBlockingIssues failed — treating as no blockers',
      )
      return []
    }
  }

  getTransitionManager(item: IssueItem, broadcast: BroadcastFn): TaskSource {
    const m = item.meta ?? {}
    const ghProjectId = m.ghProjectId as string | undefined
    if (!ghProjectId) {
      throw new Error(`Item ${item.id} missing meta.ghProjectId — not a GitHub-sourced item`)
    }
    const issueId = m.issueId as string
    const repoName = m.repoName as string | undefined
    const issueNumber = m.issueNumber as number | undefined
    // Rehydrate ProjectMeta from cache — the poll cycle populated it just
    // before dispatch, so the entry should be warm.
    const cached = peekMemoized<ProjectMeta>(this, 'loadMeta', META_KEY)
    if (!cached) {
      throw new Error(`GitHub project meta not cached for ${this.url}`)
    }
    return new GitHubTaskSource(cached, item.id, issueId, broadcast, repoName, issueNumber)
  }

  // Health report for the Overview UI — surfaces the fields the daemon needs
  // on the target GitHub Project. Callers use this to render a "misconfigured"
  // banner without having to know GitHub Project schemas themselves.
  //
  // What the poll loop actually reads:
  //   · Status  — REQUIRED. PollingIssueManager filters items by these values
  //               against the statuses configured in the DB.
  //   · Working — REQUIRED. Used as a "someone's already processing this"
  //               flag so concurrent daemons / restarts don't double-dispatch.
  //   · Repos   — recommended. Feeds the agent's context via task.repos; empty
  //               means the implementer only knows the linked issue's repo.
  async getHealth(): Promise<SourceHealth> {
    const REQUIRED = [
      { name: 'Status', purpose: 'Filtro que el daemon usa para saber qué items polear' },
      { name: 'Working', purpose: 'Flag anti-doble-procesamiento en concurrencia / reinicio' },
    ] as const
    const RECOMMENDED = [
      { name: 'Repos', purpose: 'Contexto de repos que se pasa al agente' },
    ] as const

    try {
      const meta = await this.loadMeta()
      const missing = REQUIRED.filter((f) => !meta.fields[f.name]).map((f) => ({ ...f }))
      const warnings = RECOMMENDED.filter((f) => !meta.fields[f.name]).map((f) => ({ ...f }))
      return { ok: missing.length === 0, missing, warnings }
    } catch (err) {
      return {
        ok: false,
        missing: [],
        warnings: [],
        message: `No se pudo consultar el GitHub Project: ${(err as Error).message}`,
      }
    }
  }

  // Crash-recovery: any item left with Working=Yes from a previous run gets
  // reset so we don't skip it forever (poll() skips working=true items).
  async onDaemonStart(): Promise<void> {
    try {
      const meta = await this.loadMeta()
      const workingField = meta.fields.Working
      if (!workingField) return
      const items = await listProjectItems(meta.projectId, meta.fields)
      const stuck = items.filter((i) => i.working)
      if (!stuck.length) return
      log.info({ url: this.url, count: stuck.length }, 'Resetting stuck agent_working items')
      await Promise.all(
        stuck.map((i) =>
          clearItemWorking(meta.projectId, i.id, workingField).catch(() => {
            /* non-fatal */
          }),
        ),
      )
    } catch (err) {
      log.warn({ err, url: this.url }, 'onDaemonStart failed — will retry on first poll')
    }
  }

  // Webhook routing. GitHub gives us two usable discriminators:
  //   · projects_v2* events carry the Project v2 node id — an exact match
  //     against this source's project, so unrelated boards stay asleep.
  //   · issues / issue_comment events only carry the repository, and a repo
  //     can feed several boards. We narrow by owner (cheap, cached meta) and
  //     accept the occasional extra scan rather than risk missing an item
  //     that isn't on the board yet.
  // Anything we can't resolve (network error, no discriminator) → true.
  async matchesWebhook(hint: WebhookMatchHint): Promise<boolean> {
    try {
      const meta = await this.loadMeta()
      if (hint.projectNodeId) return hint.projectNodeId === meta.projectId
      if (hint.repoFullName) {
        const owner = hint.repoFullName.split('/')[0]?.toLowerCase()
        return !owner || owner === meta.owner.toLowerCase()
      }
      return true
    } catch (err) {
      log.warn({ err, url: this.url }, 'matchesWebhook failed — scanning anyway')
      return true
    }
  }

  /**
   * Push-based watch. Always warms `loadMeta()` first — synchronously
   * required by getTransitionManager's peekMemoized read, and awaited here
   * rather than left to happen lazily on first dispatch — before touching
   * either mechanism below. `dispose()` during that warmup cancels setup
   * before anything gets registered.
   */
  watch(onItems: (items: SourceItem[]) => void, opts: WatchOptions): Disposable {
    let disposed = false
    let inner: Disposable | null = null
    const setup = async () => {
      try {
        await this.loadMeta()
      } catch (err) {
        log.warn({ err, url: this.url }, 'watch(): loadMeta warmup failed')
        opts.onError?.(err)
        return
      }
      if (disposed) return
      inner =
        opts.mode === 'polling'
          ? pollingWatch((o) => this.getItems(o), onItems, opts, log)
          : webhookWatch(onItems, {
              sourceKind: this.kind,
              opts,
              matchesWebhook: (hint) => this.matchesWebhook(hint),
              log,
              logScope: 'GitHub project',
              resolveDelivery: (delivery) => this.resolveWebhookDelivery(delivery),
            })
    }
    void setup()
    return {
      dispose: () => {
        disposed = true
        inner?.dispose()
      },
    }
  }

  /**
   * Fast path: only `projects_v2_item` carries a node id this source can
   * resolve directly (a single getItemById fetch instead of a full board
   * scan). `issues`/`issue_comment` events only tell us the repo, not which
   * board item they belong to — accepted limit, see matchesWebhook's doc on
   * why a repo can feed several boards. Those fall through to a full scan,
   * same as no delivery at all (manual nudge / fallback timer).
   */
  private async resolveWebhookDelivery(delivery?: WebhookDelivery): Promise<SourceItem[]> {
    const itemNodeId = (delivery?.payload.projects_v2_item as { node_id?: unknown } | undefined)
      ?.node_id
    if (typeof itemNodeId === 'string') {
      const item = await this.getItemById(itemNodeId)
      if (item) return [item]
    }
    return this.getItems({ refresh: true })
  }
}

// Compose a draft body from the task fields we care about. Kept minimal: just
// the human description on top, so the daemon path (which strips prior AI
// history after the first "---") still works if the agent appends output.
function resolveRepos(repos: unknown, hostRepo: string | undefined): string[] {
  const fromField =
    typeof repos === 'string'
      ? repos
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean)
      : []
  if (fromField.length > 0) return fromField
  return hostRepo ? [hostRepo] : []
}

function buildDraftBody(input: {
  description?: string
  type?: string
  repos?: string[]
}): string {
  const parts: string[] = []
  if (input.description) parts.push(input.description.trim())
  const meta: string[] = []
  if (input.type) meta.push(`Type: ${input.type}`)
  if (input.repos?.length) meta.push(`Repos: ${input.repos.join(', ')}`)
  if (meta.length) parts.push(meta.join('\n'))
  return parts.join('\n\n')
}
