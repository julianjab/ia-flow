import type { TaskComment } from '@ia-flow/shared'
import type {
  Blocker,
  BroadcastFn,
  CreateItemInput,
  Disposable,
  IssueItem,
  ProjectSource,
  SourceHealth,
  SourceHealthField,
  SourceItem,
  SourceProjectField,
  StatusOption,
  TaskSource,
  UpdateItemInput,
  WatchOptions,
  WebhookMatchHint,
} from '../contract.js'
import { pollingWatch, webhookWatch } from '../dispatch/watch-helpers.js'
import type { WebhookDelivery } from '../dispatch/webhook-registry.js'
import { fromWebhookPayload } from '../github-issues/api/issues-client.js'
import { GitHubIssueSource } from '../github-issues/source.js'
import { GitHubProjectSource } from '../github-project/source.js'
import { createLogger } from '../logger.js'

const log = createLogger('github-hybrid-source')

/**
 * Un issue de GitHub que ADEMÁS puede estar agregado a un Project v2 board —
 * compone `GitHubIssueSource` y `GitHubProjectSource` en vez de reimplementar
 * ninguno de los dos (mismo motivo por el que `GitHubIssueSource` no hereda de
 * `GitHubProjectSource`: acá el punto es justo lo contrario, tener las DOS
 * fuentes de verdad vivas a la vez).
 *
 * **El set de items rastreados lo define `issues`** (label ancla / todo issue
 * abierto) — el board NO agrega ni saca issues del scan, sólo los enriquece.
 * Así un issue que todavía no llegó al board sigue viéndose (con status vacío
 * o el de su label `status:*`, según `github-issues`), y uno que sale del
 * board sin perder la label ancla no desaparece de golpe.
 *
 * **Cuando un issue SÍ está en el board, gana por completo el item que
 * devuelve `GitHubProjectSource`** — no se mergea campo a campo: ese item ya
 * trae los nativos del issue (title, body, labels, assignees) Y los del board
 * (Status, custom fields) en un solo objeto (`GitHubProjectSource.toSourceItem`
 * lee `content{...on Issue{...}}` de la misma query). La única excepción es
 * `status`: si el board no tiene el campo Status seteado para ese item
 * (`''`), se conserva el status derivado de la label — perder el status del
 * pipeline porque alguien agregó el issue al board sin llenar la columna
 * sería peor que la inconsistencia que esto evita.
 */
export class GithubHybridSource implements ProjectSource {
  readonly kind = 'github-hybrid'

  constructor(
    private readonly issues: GitHubIssueSource,
    private readonly project: GitHubProjectSource,
  ) {}

  async getItems(opts?: { status?: string; refresh?: boolean }): Promise<SourceItem[]> {
    const [issueItems, projectItems] = await Promise.all([
      this.issues.getItems({ refresh: opts?.refresh }),
      this.project.getItems({ refresh: opts?.refresh }).catch((err) => {
        log.warn({ err }, 'getItems: el lado Project falló — sigo sólo con los issues')
        return [] as SourceItem[]
      }),
    ])
    const merged = mergeByIssueId(issueItems, projectItems)
    if (!opts?.status) return merged
    const wanted = opts.status.toLowerCase()
    return merged.filter((i) => i.status.toLowerCase() === wanted)
  }

  /** Prueba primero como id de ProjectV2Item (el caso común de un delivery
   *  `projects_v2_item` o de `DivergenceReconciler`); si no resuelve, lo
   *  prueba como node id de Issue y busca su contraparte en el board. */
  async getItemById(id: string): Promise<SourceItem | null> {
    const asProjectItem = await this.project.getItemById(id).catch(() => null)
    if (asProjectItem) return asProjectItem
    const asIssue = await this.issues.getItemById(id).catch(() => null)
    if (!asIssue) return null
    return this.attachProjectCounterpart(asIssue)
  }

  /** Busca en los items YA cacheados del board (`GitHubProjectSource` los
   *  memoiza `ITEMS_TTL_MS`) el que corresponde a este issue por `issueId`.
   *  Sin query GraphQL nueva: reusa el bulk que el lado Project ya trae
   *  mergeado. `null`/falla del lado Project ⇒ se queda con el item del
   *  issue solo, nunca revienta por esto. */
  private async attachProjectCounterpart(issueItem: SourceItem): Promise<SourceItem> {
    try {
      const projectItems = await this.project.getItems()
      const match = projectItems.find((p) => p.meta?.issueId === issueItem.id)
      if (!match) return issueItem
      return match.status ? match : { ...match, status: issueItem.status }
    } catch (err) {
      log.warn({ err, issueId: issueItem.id }, 'attachProjectCounterpart falló — sigo sin el board')
      return issueItem
    }
  }

  /** El item de un board ya trae `meta.ghProjectId` (`GitHubProjectSource`)
   *  — es la marca que dice "esto vino/existe en el Project". Sin ella, es
   *  un item de `github-issues` puro. */
  private isOnBoard(item: { meta?: Record<string, unknown> }): boolean {
    return typeof item.meta?.ghProjectId === 'string'
  }

  toIssueItem(item: SourceItem): IssueItem {
    return this.isOnBoard(item) ? this.project.toIssueItem(item) : this.issues.toIssueItem(item)
  }

  getTransitionManager(item: IssueItem, broadcast: BroadcastFn): TaskSource {
    return this.isOnBoard(item)
      ? this.project.getTransitionManager(item, broadcast)
      : this.issues.getTransitionManager(item, broadcast)
  }

  async getStatuses(opts?: { refresh?: boolean }): Promise<StatusOption[]> {
    const [fromProject, fromIssues] = await Promise.all([
      this.project.getStatuses(opts).catch(() => []),
      this.issues.getStatuses(),
    ])
    return dedupeByName([...fromProject, ...fromIssues])
  }

  async getFields(opts?: { refresh?: boolean }): Promise<SourceProjectField[]> {
    const [fromProject, fromIssues] = await Promise.all([
      this.project.getFields?.(opts) ?? Promise.resolve([]),
      this.issues.getFields(opts),
    ])
    // El del board gana cuando el mismo nombre aparece en los dos (trae
    // dataType/options más ricos — viene de un Single Select real, no de un
    // catálogo de labels inferido).
    return dedupeByName([...fromProject, ...fromIssues])
  }

  async loadComments(item: IssueItem): Promise<TaskComment[]> {
    return this.isOnBoard(item) ? this.project.loadComments(item) : this.issues.loadComments(item)
  }

  async markCommentsUsed(comments: Array<{ id: string; body: string }>): Promise<void> {
    // Misma implementación de fondo (`github-shared/issue.js`) para los dos
    // lados — cualquiera de las dos alcanza.
    await this.issues.markCommentsUsed(comments)
  }

  async getBlockers(item: IssueItem): Promise<Blocker[]> {
    return this.isOnBoard(item) ? this.project.getBlockers(item) : this.issues.getBlockers(item)
  }

  async getSlackThreadUrl(item: IssueItem): Promise<string | undefined> {
    return this.isOnBoard(item)
      ? this.project.getSlackThreadUrl(item)
      : this.issues.getSlackThreadUrl(item)
  }

  async setSlackThreadUrl(item: IssueItem, url: string): Promise<void> {
    return this.isOnBoard(item)
      ? this.project.setSlackThreadUrl(item, url)
      : this.issues.setSlackThreadUrl(item, url)
  }

  async setItemField(itemId: string, field: string, value: string): Promise<void> {
    // Sólo el board tiene campos custom seteables — `github-issues` no
    // implementa `setItemField` (sus campos son labels, se escriben por
    // `setLabels` del lado del TaskSource, no acá).
    if (!this.project.setItemField) {
      throw new Error(`setItemField no soportado: '${field}' no es un campo del board`)
    }
    await this.project.setItemField(itemId, field, value)
  }

  /** Crea el issue vía `github-issues` (labels/ancla) — no lo agrega al
   *  board automáticamente. Si el board lo espera agregado, agregalo desde
   *  GitHub; el próximo scan lo mergea solo. */
  async createItem(input: CreateItemInput): Promise<SourceItem> {
    return this.issues.createItem(input)
  }

  async updateItem(id: string, patch: UpdateItemInput): Promise<SourceItem> {
    const asProjectItem = await this.project.getItemById(id).catch(() => null)
    return asProjectItem ? this.project.updateItem(id, patch) : this.issues.updateItem(id, patch)
  }

  async deleteItem(id: string): Promise<void> {
    const asProjectItem = await this.project.getItemById(id).catch(() => null)
    if (!asProjectItem) {
      throw new Error(
        `deleteItem no soportado: '${id}' no es un item del board (github-issues no borra issues)`,
      )
    }
    if (!this.project.deleteItem)
      throw new Error('deleteItem no soportado por el board configurado')
    await this.project.deleteItem(id)
  }

  async getHealth(): Promise<SourceHealth> {
    const [fromProject, fromIssues] = await Promise.all([
      this.project.getHealth(),
      this.issues.getHealth(),
    ])
    return {
      ok: fromProject.ok && fromIssues.ok,
      missing: dedupeFields([...fromProject.missing, ...fromIssues.missing]),
      warnings: dedupeFields([...fromProject.warnings, ...fromIssues.warnings]),
      message: fromProject.message ?? fromIssues.message,
    }
  }

  async onDaemonStart(): Promise<void> {
    await Promise.all([this.issues.onDaemonStart?.(), this.project.onDaemonStart?.()])
  }

  async matchesWebhook(hint: WebhookMatchHint): Promise<boolean> {
    const [fromIssues, fromProject] = await Promise.all([
      this.issues.matchesWebhook?.(hint) ?? Promise.resolve(true),
      this.project.matchesWebhook?.(hint) ?? Promise.resolve(true),
    ])
    return fromIssues || fromProject
  }

  watch(onItems: (items: SourceItem[]) => void, opts: WatchOptions): Disposable {
    return opts.mode === 'polling'
      ? pollingWatch((o) => this.getItems(o), onItems, opts, log)
      : webhookWatch(onItems, {
          sourceKind: this.kind,
          opts,
          matchesWebhook: (hint) => this.matchesWebhook(hint),
          log,
          logScope: 'GitHub hybrid (issues + project)',
          resolveDelivery: (delivery) => this.resolveWebhookDelivery(delivery),
        })
  }

  /**
   * Cubre los dos discriminadores que un board+issues puede recibir:
   *   · `projects_v2_item` — node id del item, fast path del lado Project
   *     (ya trae nativos + board mergeados).
   *   · `issues`/`issue_comment` — payload-first del lado issues
   *     (`fromWebhookPayload`), enriquecido con el board si existe.
   * Sin delivery (nudge manual / fallback timer) → scan completo mergeado.
   */
  private async resolveWebhookDelivery(delivery?: WebhookDelivery): Promise<SourceItem[]> {
    if (delivery) {
      const itemNodeId = (delivery.payload.projects_v2_item as { node_id?: unknown } | undefined)
        ?.node_id
      if (typeof itemNodeId === 'string') {
        const item = await this.project.getItemById(itemNodeId)
        if (item) return [item]
      }
      // `fromWebhookPayload` sólo confirma que el payload trae un issue
      // completo — no evitamos el request de todos modos: `getItemById` es
      // la única vía pública a `withDevLinks` (privado en GitHubIssueSource
      // a propósito, ver su comentario), así que el "fast path" acá es no
      // tener que armar un `SourceItem` a mano, no ahorrarse la llamada.
      const direct = fromWebhookPayload(delivery.payload)
      if (direct) {
        const issueItem = await this.issues.getItemById(direct.id)
        if (issueItem) return [await this.attachProjectCounterpart(issueItem)]
      }
    }
    return this.getItems({ refresh: true })
  }
}

/** El item del board (con `issueId` en su `meta`) reemplaza por completo al
 *  del issue cuando existe — ver el comentario de la clase sobre por qué no
 *  se mergea campo a campo. Exportada para poder testear el merge sin fakear
 *  las dos fuentes completas (que hablan GraphQL/REST de verdad). */
export function mergeByIssueId(issueItems: SourceItem[], projectItems: SourceItem[]): SourceItem[] {
  const byIssueId = new Map<string, SourceItem>()
  for (const p of projectItems) {
    const issueId = p.meta?.issueId
    if (typeof issueId === 'string') byIssueId.set(issueId, p)
  }
  return issueItems.map((i) => {
    const match = byIssueId.get(i.id)
    if (!match) return i
    return match.status ? match : { ...match, status: i.status }
  })
}

/** Gana la PRIMERA aparición de cada nombre (case-insensitive) — los
 *  llamadores pasan la lista que debe ganar primero en el array. */
export function dedupeByName<T extends { name: string }>(items: T[]): T[] {
  const byName = new Map<string, T>()
  for (const item of items) {
    const key = item.name.toLowerCase()
    if (!byName.has(key)) byName.set(key, item)
  }
  return [...byName.values()]
}

function dedupeFields(fields: SourceHealthField[]): SourceHealthField[] {
  const byName = new Map<string, SourceHealthField>()
  for (const f of fields) byName.set(f.name, f)
  return [...byName.values()]
}
