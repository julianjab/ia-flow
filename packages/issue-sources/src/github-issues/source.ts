import { invalidateMemoized, memoize } from '@ia-flow/shared'
import type { PullRequestRef, TaskComment } from '@ia-flow/shared'
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
import { fetchConversation } from '../github-shared/conversation.js'
import { type IssueDevLinks, branchTreeUrl, openPullRequests } from '../github-shared/dev-links.js'
import { markCommentsUsed as markIssueCommentsUsed } from '../github-shared/issue.js'
import { readSlackThreadUrlFromPr, saveSlackThreadUrlInPr } from '../github-shared/pull-request.js'
import {
  extractSlackThreadUrl,
  preserveSlackSection,
  stripSlackSection,
  upsertSlackSection,
} from '../github-shared/slack-section.js'
import { createLogger } from '../logger.js'
import { GitHubIssuesApi, type RestIssue, fromWebhookPayload } from './api/issues-client.js'
import { FieldLabelCodec } from './field-label.js'
import { StatusLabelCodec, WORKING_LABEL, withWorking } from './status-label.js'
import { GitHubIssueTaskSource } from './task-source.js'

const log = createLogger('github-issue-source')

const ITEMS_TTL_MS = 60 * 1000
const bypassOnRefresh = (opts?: { refresh?: boolean }) => opts?.refresh === true

export interface GitHubIssueSourceConfig {
  owner: string
  repo: string
  /** Only issues carrying this label are visible to the engine. Optional:
   * omitirla es un modo deliberado ("sin ancla") en el que TODO issue abierto
   * del repo es candidato — pensado para repos dedicados al engine, donde no
   * hay issues humanos que convenga dejar fuera. Con un repo compartido
   * seguí poniéndola: sin ancla no hay forma de excluir un issue del scan.
   * Cuando está, además es bookkeeping protegido (task-source.ts,
   * protectBookkeeping) y se agrega sola a los issues que crea el engine. */
  anchorLabel?: string
}

/**
 * ProjectSource over plain GitHub issues in one repo — no Projects v2 board
 * required. Sibling of GitHubProjectSource (github-project/source.ts), not a
 * subclass: the two barely share behavior (status comes from a Project
 * Single-Select field there, from a label here), so inheritance would just be
 * empty overrides. What they DO share — issue-level REST/GraphQL calls
 * (comments, body, blockers, labels, linked branches) — lives in
 * github-project/api/* already and is reused directly by GitHubIssuesApi.
 */
export class GitHubIssueSource implements ProjectSource {
  readonly kind = 'github-issues'

  constructor(
    private readonly config: GitHubIssueSourceConfig,
    private readonly api: GitHubIssuesApi = new GitHubIssuesApi(),
    private readonly statusLabels: StatusLabelCodec = new StatusLabelCodec(),
    private readonly fieldLabels: FieldLabelCodec = new FieldLabelCodec(),
  ) {}

  @memoize({ ttlMs: ITEMS_TTL_MS, key: () => 'items', bypass: bypassOnRefresh })
  private async fetchItems(_opts?: { refresh?: boolean }): Promise<SourceItem[]> {
    const { owner, repo, anchorLabel } = this.config
    const issues = await this.api.listIssues(owner, repo, anchorLabel, 'open')
    return this.withDevLinks(issues)
  }

  /** toSourceItem para una tanda de issues, más los dev links (branch del
   * Development panel + PRs que cierran el issue) de todos ellos.
   *
   * En bulk a propósito: GitHubProjectSource obtiene lo mismo gratis dentro de
   * su query de items, y acá el listado REST no los trae — pedirlos por issue
   * sería un request por tarjeta del listado. `getDevLinks` los resuelve en un
   * request cada 100 issues. Sin esto, `toIssueItem().branch` sería siempre
   * undefined y resolveLinkedBranch (agent-engine) crearía una branch nueva en
   * cada run aunque el issue ya tenga una. */
  private async withDevLinks(issues: RestIssue[]): Promise<SourceItem[]> {
    const items = issues.map((issue) => this.toSourceItem(issue))
    if (!items.length) return items
    const links = await this.api
      .getDevLinks(
        issues.map((i) => i.id),
        this.config.repo,
      )
      .catch((err) => {
        log.warn(
          { err: (err as Error).message },
          'getDevLinks failed — proceeding without branch/PR info',
        )
        return new Map<string, IssueDevLinks>()
      })
    for (const item of items) {
      const link = links.get(item.id)
      if (!link) {
        log.debug({ itemId: item.id }, `Skipping dev links for issue ${item.id} — none returned`)
        continue
      }
      item.meta = {
        ...item.meta,
        ...(link.branch
          ? {
              linkedBranch: link.branch,
              // El adapter arma el link: es él quien conoce la forma de una
              // URL de GitHub, no la UI que la muestra.
              branchUrl: branchTreeUrl(
                link.branchOwner ?? this.config.owner,
                link.branchRepo ?? this.config.repo,
                link.branch,
              ),
            }
          : {}),
        pullRequests: link.pullRequests,
        pullRequestsKnown: link.pullRequestsKnown,
      }
    }
    return items
  }

  private toSourceItem(issue: RestIssue): SourceItem {
    const { owner, repo } = this.config
    return {
      id: issue.id,
      title: issue.title,
      status: this.statusLabels.statusFromLabels(issue.labels),
      repos: repo,
      url: issue.url,
      meta: {
        issueId: issue.id,
        issueNumber: issue.number,
        repoName: repo,
        owner,
        issueUrl: issue.url,
        issueBody: issue.body,
        // Gratis: el body del issue YA vino en el scan, así que la tarjeta
        // dibuja el tag del hilo sin un request extra. Es la mitad de la razón
        // por la que el link canónico vive acá y no sólo en el PR.
        slackThreadUrl: extractSlackThreadUrl(issue.body),
        labels: issue.labels,
        assignees: issue.assignees,
        working: issue.labels.includes(WORKING_LABEL),
        // field:<name>=<value> labels → {name: value}, so `when` conditions
        // and {{task.fields.*}} read a github-issues field the same way
        // they'd read a GitHub Project custom column.
        fields: this.fieldLabels.fieldsFromLabels(issue.labels),
      },
    }
  }

  /** No Project board to enumerate a Status field from — the available
   * statuses are whatever status labels exist on the repo, per the injected
   * StatusLabelCodec's prefix (not a hardcoded 'status:'). */
  async getStatuses(): Promise<StatusOption[]> {
    const labels = await this.api.listRepoLabels(this.config.owner, this.config.repo)
    return this.statusLabels.statusesFromCatalog(labels).map((name) => ({ name }))
  }

  /** Field names (+ observed values) discovered from the repo's `field:*`
   * label catalog — same idea as GitHubProjectSource's synthetic `Labels`
   * field: derived from what's already in use, not a fixed schema, so the
   * UI's condition editor has something to offer without requiring every
   * possible value to be created up front. */
  async getFields(_opts?: { refresh?: boolean }): Promise<SourceProjectField[]> {
    const labels = await this.api.listRepoLabels(this.config.owner, this.config.repo)
    // One fetch feeds both: Status comes from the same StatusLabelCodec
    // getStatuses() uses, custom fields from FieldLabelCodec — no need for
    // getFields() to call getStatuses() separately and hit the API twice.
    //
    // Status is prepended unconditionally (not just when field:* labels
    // exist): before getFields() existed, ProjectSource.getFields being
    // absent made the /source/fields route fall back to a synthetic
    // { name: 'Status', ... } entry so the condition editor always had
    // something to offer. Now that getFields() exists, that fallback never
    // runs — recreate the same guarantee here, or a repo with no field:*
    // labels yet would leave the editor with zero options.
    const statusNames = this.statusLabels.statusesFromCatalog(labels)
    const optionsByField = new Map<string, Set<string>>()
    for (const label of labels) {
      const parsed = this.fieldLabels.parse(label)
      if (!parsed) continue
      const values = optionsByField.get(parsed.name) ?? new Set<string>()
      values.add(parsed.value)
      optionsByField.set(parsed.name, values)
    }
    const custom = [...optionsByField.entries()].map(([name, values]) => ({
      name,
      dataType: 'TEXT',
      options: [...values].sort(),
    }))
    // `Labels` es el campo multi-valor de este source. No estaba en el
    // catálogo: el editor no tenía forma de saber que existía, ni de saber
    // que va con tokens con signo, aunque el runtime ya lo escribiera así.
    // Las opciones son las labels "de usuario": se filtran las que son
    // bookkeeping del propio source (el ancla, los `status:*` y los
    // `field:*`), que ya viajan como Status y como campos propios.
    const userLabels = labels
      .filter((l) => l !== this.config.anchorLabel)
      .filter((l) => !this.statusLabels.isStatusLabel(l))
      .filter((l) => !this.fieldLabels.parse(l))
      .sort()
    // `Assignees` y `Repository` son campos del issue que el evaluador de
    // `when` ya resuelve (ver FIELD_ALIASES en dispatch/when.ts: ambos caen a
    // las keys top-level de Task, con semántica de membresía porque son
    // arrays), pero no salen de ningún catálogo de labels — sin declararlos
    // acá el editor de condiciones no los ofrecía y una condición guardada
    // sobre `assignees` se mostraba con el campo vacío. Van sin `options`
    // (el catálogo de logins/repos no vale una request extra), así que el
    // editor cae al input libre — que es lo que hace falta para escribir un
    // login. Mismos pseudo-campos que expone GitHubProjectSource.getFields.
    return [
      { name: 'Status', dataType: 'SINGLE_SELECT', options: statusNames },
      { name: 'Labels', dataType: MULTI_SELECT_DATA_TYPE, options: userLabels },
      { name: 'Assignees', dataType: 'TEXT' },
      { name: 'Repository', dataType: 'TEXT' },
      ...custom,
    ]
  }

  async getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]> {
    const items = await this.fetchItems({ refresh: opts?.refresh })
    if (!opts?.status) return items
    const wanted = opts.status.toLowerCase()
    return items.filter((i) => {
      if (i.status.toLowerCase() === wanted) return true
      log.debug(
        { itemId: i.id, status: i.status, wanted: opts.status },
        `Skipping issue ${i.id} — status '${i.status}' does not match requested '${opts.status}'`,
      )
      return false
    })
  }

  /** Direct GraphQL node(id) lookup (GitHubIssuesApi.getById) — not a scan
   * over the cached getItems() list, so this reflects the issue's true
   * current state even if it's no longer anchor-labeled (DivergenceReconciler
   * relies on that: a task in flight must stay reconcilable even if its
   * anchor label got removed mid-run). */
  async getItemById(id: string): Promise<SourceItem | null> {
    const issue = await this.api.getById(id)
    if (!issue) return null
    const [item] = await this.withDevLinks([issue])
    return item ?? null
  }

  toIssueItem(item: SourceItem): IssueItem {
    const meta = item.meta ?? {}
    // El bloque del hilo de Slack es bookkeeping nuestro, no parte del PRD:
    // sale antes de partir por el separador para que un agente no lo lea como
    // requisito ni lo arrastre al reescribir la descripción.
    const rawBody = stripSlackSection(meta.issueBody as string | undefined)
    // Same convention as GitHubProjectSource: strip any prior AI history the
    // daemon appended after the first "---" separator.
    const description = rawBody.split('\n\n---\n\n')[0].trim()
    return {
      id: item.id,
      title: item.title,
      description,
      type: '',
      repos: [this.config.repo],
      status: item.status,
      agentWorking: meta.working === true,
      issueNumber: meta.issueNumber as number | undefined,
      issueUrl: meta.issueUrl as string | undefined,
      labels: (meta.labels as string[] | undefined) ?? [],
      assignees: (meta.assignees as string[] | undefined) ?? [],
      fields: (meta.fields as Record<string, string> | undefined) ?? {},
      // Branch linkeada al issue vía Development panel — poblada por
      // withDevLinks. Undefined si no hay ninguna.
      branch: (meta.linkedBranch as string | undefined) ?? undefined,
      meta,
    }
  }

  // Ver el gemelo en github-project/source.ts: issue + PRs abiertos en una
  // sola query, con los node ids que `withDevLinks` ya dejó en el item.
  async loadComments(item: IssueItem): Promise<TaskComment[]> {
    const issueId = item.meta?.issueId as string | undefined
    if (!issueId) return []
    try {
      return await fetchConversation(
        issueId,
        item.meta?.pullRequests as PullRequestRef[] | undefined,
      )
    } catch (err) {
      log.warn({ err: (err as Error).message, issueId }, 'loadComments failed — returning empty')
      return []
    }
  }

  async markCommentsUsed(comments: Array<{ id: string; body: string }>): Promise<void> {
    await markIssueCommentsUsed(comments)
  }

  // ─── Hilo de review en Slack ────────────────────────────────────────────
  //
  // Esta fuente no tiene board, así que no hay campo donde guardar el link. Se
  // escribe en DOS lados, y no es una duplicación accidental — cada uno paga
  // algo distinto:
  //
  //   - El **cuerpo del issue** es el canónico. Ya viene en el scan, así que
  //     leerlo es gratis: es lo que permite publicar `meta.slackThreadUrl` y
  //     que la tarjeta muestre "Pedir re-review" antes de que la toques.
  //     Además sobrevive al PR — si el PR se cierra y se abre otro, el hilo
  //     sigue siendo el de la tarea.
  //   - El **cuerpo del PR** es la copia visible: es donde lo va a encontrar
  //     quien abre el PR sin pasar por ia-flow.
  //
  // La regla de precedencia es fija —**gana el issue**— así que la pregunta
  // "cuál vale cuando discrepan" tiene una sola respuesta. La lectura cae al PR
  // sólo cuando el issue no tiene nada, que es el caso de los links escritos
  // antes de este cambio: se migran solos en el próximo pedido de review.

  private openPr(item: IssueItem) {
    return openPullRequests(item.meta?.pullRequests as PullRequestRef[] | undefined)[0]
  }

  async getSlackThreadUrl(item: IssueItem): Promise<string | undefined> {
    const fromIssue = extractSlackThreadUrl(item.meta?.issueBody as string | undefined)
    if (fromIssue) return fromIssue
    const nodeId = this.openPr(item)?.nodeId
    return nodeId ? readSlackThreadUrlFromPr(nodeId) : undefined
  }

  async setSlackThreadUrl(item: IssueItem, url: string): Promise<void> {
    const issueId = item.meta?.issueId as string | undefined
    if (!issueId) throw new Error('El item no trae issueId: no hay dónde guardar el link del hilo')
    // Se re-lee el body en vez de usar el del item, por el mismo motivo que
    // `saveOutput`: escribimos el cuerpo ENTERO, y entre el scan y este write
    // hubo dos llamadas a Slack (postMessage + getPermalink). Un agente que
    // haya guardado su PRD en esa ventana quedaría revertido en silencio.
    const current = await this.api.getById(issueId)
    await this.api.updateBody(issueId, upsertSlackSection(current?.body ?? '', url))
    invalidateMemoized(this, 'fetchItems')

    // El PR es la copia, no la fuente de verdad: que falle no invalida el
    // guardado. Tirar acá haría que el use-case reportara `threadNotPersisted`
    // por un link que SÍ quedó guardado donde importa.
    const nodeId = this.openPr(item)?.nodeId
    if (!nodeId) return
    try {
      await saveSlackThreadUrlInPr(nodeId, url)
    } catch (err) {
      log.warn(
        { err: (err as Error).message, issueId },
        'No se pudo copiar el link del hilo al PR — queda en el cuerpo del issue',
      )
    }
  }

  async getBlockers(item: IssueItem) {
    const issueNumber = item.issueNumber
    if (issueNumber == null) return []
    const { owner, repo } = this.config
    try {
      const blockers = await this.api.getBlockers(owner, repo, issueNumber)
      return blockers
        .filter((b) => b.state !== 'closed')
        .map((b) => ({
          id: `${owner}/${repo}#${b.number}`,
          ref: `#${b.number}`,
          title: b.title,
          status: b.state,
          url: `https://github.com/${owner}/${repo}/issues/${b.number}`,
        }))
    } catch (err) {
      log.warn(
        { err: (err as Error).message, issueNumber },
        'getBlockers failed — treating as no blockers',
      )
      return []
    }
  }

  getTransitionManager(item: IssueItem, broadcast: BroadcastFn): TaskSource {
    return new GitHubIssueTaskSource(
      this.config,
      this.api,
      this.statusLabels,
      this.fieldLabels,
      item,
      broadcast,
    )
  }

  async createItem(input: CreateItemInput): Promise<SourceItem> {
    const { owner, repo, anchorLabel } = this.config
    const created = await this.api.create(owner, repo, input.title, input.description ?? '')
    // Sin ancla no hay nada que estampar para que el scan lo vea (todo issue
    // abierto ya es candidato), así que el array puede quedar vacío — y
    // replaceLabels([]) es correcto: un issue recién creado no tiene labels
    // que borrar.
    const labels = [
      ...(anchorLabel ? [anchorLabel] : []),
      ...(input.status ? [this.statusLabels.labelFor(input.status)] : []),
    ]
    await this.api.replaceLabels(owner, repo, created.number, labels)
    invalidateMemoized(this, 'fetchItems')
    return this.toSourceItem({ ...created, labels })
  }

  async updateItem(id: string, patch: UpdateItemInput): Promise<SourceItem> {
    const current = await this.getItemById(id)
    if (!current) throw new Error(`Item '${id}' not found`)
    const { owner, repo } = this.config
    const issueNumber = current.meta?.issueNumber as number
    if (patch.status) {
      // Re-read from GitHub, not `current.meta.labels` — that came from
      // fetchItems' memoized cache (up to 60s stale). A replace built off it
      // would drop any label added elsewhere in that window, same failure
      // mode fixed in GitHubIssueTaskSource.freshLabels.
      const fresh = await this.api.getByNumber(owner, repo, issueNumber)
      const freshLabels = fresh?.labels ?? (current.meta?.labels as string[] | undefined) ?? []
      const nextLabels = this.statusLabels.withStatus(freshLabels, patch.status)
      await this.api.replaceLabels(owner, repo, issueNumber, nextLabels)
    }
    if (patch.description !== undefined) {
      await this.api.updateBody(
        current.meta?.issueId as string,
        preserveSlackSection(current.meta?.issueBody as string | undefined, patch.description),
      )
    }
    invalidateMemoized(this, 'fetchItems')
    const refreshed = await this.getItemById(id)
    return refreshed ?? current
  }

  // Crash-recovery: any issue left with the Working label from a previous run
  // gets it cleared so poll() doesn't skip it forever.
  async onDaemonStart(): Promise<void> {
    const { owner, repo, anchorLabel } = this.config
    try {
      const issues = await this.api.listIssues(owner, repo, anchorLabel, 'open')
      const stuck = issues.filter((i) => i.labels.includes(WORKING_LABEL))
      if (!stuck.length) return
      log.info({ owner, repo, count: stuck.length }, 'Resetting stuck agent_working labels')
      await Promise.all(
        stuck.map((i) =>
          this.api.replaceLabels(owner, repo, i.number, withWorking(i.labels, false)).catch(() => {
            /* non-fatal */
          }),
        ),
      )
    } catch (err) {
      log.warn({ err, owner, repo }, 'onDaemonStart failed — will retry on first poll')
    }
  }

  // Webhook routing: `issues`/`issue_comment` deliveries only carry the repo,
  // so match on owner+repo — good enough, a spurious scan is cheap.
  async matchesWebhook(hint: WebhookMatchHint): Promise<boolean> {
    if (!hint.repoFullName) return true
    const [owner, repo] = hint.repoFullName.split('/')
    return (
      (owner ?? '').toLowerCase() === this.config.owner.toLowerCase() &&
      (repo ?? '').toLowerCase() === this.config.repo.toLowerCase()
    )
  }

  async getHealth(): Promise<SourceHealth> {
    const { owner, repo, anchorLabel } = this.config
    const missing = [
      !owner && { name: 'owner', purpose: 'Org/user dueño del repo' },
      !repo && { name: 'repo', purpose: 'Repo a vigilar' },
    ].filter((f): f is { name: string; purpose: string } => Boolean(f))
    // No es `missing` (el source funciona sin ancla, ver anchorLabel arriba)
    // pero sí un warning: es la diferencia entre vigilar los issues marcados
    // y vigilar el repo entero, y conviene que sea una decisión visible en
    // la UI de health y no un campo que alguien olvidó llenar.
    const warnings = anchorLabel
      ? []
      : [
          {
            name: 'anchorLabel',
            purpose:
              'Sin ancla: TODO issue abierto del repo entra al engine. Ponela si el repo también tiene issues que no debe tocar.',
          },
        ]
    return { ok: missing.length === 0, missing, warnings }
  }

  /**
   * Push-based watch — replaces the old design where a generic manager
   * decided the fetch strategy. `mode: 'polling'` just arms a steady-state
   * timer (the boot scan is SourceDispatcher's job, not this method's — no
   * immediate tick here, to avoid a duplicate scan on startup).
   * `mode: 'webhook'` registers with webhook-registry and resolves each
   * delivery to a SourceItem straight from its payload when possible (see
   * fromWebhookPayload) — zero GitHub API calls for the common case.
   */
  watch(onItems: (items: SourceItem[]) => void, opts: WatchOptions): Disposable {
    return opts.mode === 'polling'
      ? pollingWatch((o) => this.getItems(o), onItems, opts, log)
      : webhookWatch(onItems, {
          sourceKind: this.kind,
          opts,
          matchesWebhook: (hint) => this.matchesWebhook(hint),
          log,
          logScope: 'GitHub issues',
          resolveDelivery: (delivery) => this.resolveWebhookDelivery(delivery),
        })
  }

  /**
   * Payload-first: an `issues`/`issue_comment` delivery usually carries the
   * full issue already (fromWebhookPayload), so the common case resolves
   * with zero GitHub API calls. Falls back to a single getByNumber when the
   * payload is incomplete, then to a full getItems() scan when there's no
   * delivery at all (manual nudge / fallback timer) or nothing in it
   * resolves to an issue.
   */
  private async resolveWebhookDelivery(delivery?: WebhookDelivery): Promise<SourceItem[]> {
    if (delivery) {
      const direct = fromWebhookPayload(delivery.payload)
      if (direct) return this.withDevLinks([direct])

      const rawIssue = delivery.payload.issue as { number?: unknown } | undefined
      const number = typeof rawIssue?.number === 'number' ? rawIssue.number : undefined
      if (number != null) {
        const fetched = await this.api.getByNumber(this.config.owner, this.config.repo, number)
        if (fetched) return this.withDevLinks([fetched])
      }
    }
    return this.getItems({ refresh: true })
  }
}
