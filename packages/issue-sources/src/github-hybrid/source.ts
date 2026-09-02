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
import { GitHubIssueSource, type GitHubIssueSourceConfig } from '../github-issues/source.js'
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
 * abierto, en el repo de `issuesConfig`) — el board NO agrega ni saca issues
 * del scan, sólo los enriquece. Así un issue que todavía no llegó al board
 * sigue viéndose (con el status de su label `status:*`), y uno que sale del
 * board sin perder la label ancla no desaparece de golpe. Un item del board
 * que pertenece a OTRO repo, o al mismo repo pero sin la anchor label
 * configurada, no cuenta como tracked — ver `isTracked`.
 *
 * **La identidad pública de un item (`SourceItem.id`/`IssueItem.id`) es
 * SIEMPRE la del Issue, nunca la del ProjectV2Item.** El daemon keyea tasks
 * en vuelo por ese id (`DivergenceReconciler`, los índices de pending tasks);
 * si cambiara según si el issue está o no en el board en ESE momento, agregar
 * o sacar un issue del board con un run en curso lo haría ver como una task
 * "nueva" y dispararía un segundo dispatch. El id real del ProjectV2Item
 * —el que hace falta para escribirle— viaja aparte en
 * `meta.projectItemId`, y sólo `getTransitionManager` lo usa.
 *
 * **Cuando un issue SÍ está en el board (y tracked), gana por completo el
 * resto del item que devuelve `GitHubProjectSource`** — no se mergea campo a
 * campo: ese item ya trae los nativos del issue (title, body, labels,
 * assignees) Y los del board (Status, custom fields) en un solo objeto
 * (`GitHubProjectSource.toSourceItem` lee `content{...on Issue{...}}` de la
 * misma query). La única excepción es `status`: si el board no tiene el
 * campo Status seteado para ese item (`''`), se conserva el status derivado
 * de la label — perder el status del pipeline porque alguien agregó el
 * issue al board sin llenar la columna sería peor que la inconsistencia que
 * esto evita.
 */
export class GithubHybridSource implements ProjectSource {
  readonly kind = 'github-hybrid'

  constructor(
    private readonly issues: GitHubIssueSource,
    private readonly project: GitHubProjectSource,
    private readonly issuesConfig: GitHubIssueSourceConfig,
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

  /**
   * Prueba primero como node id de Issue — es lo que la identidad pública
   * de este source emite en todos lados (ver el comentario de la clase),
   * así que es el caso común para `DivergenceReconciler` y para las rutas
   * REST. Si no resuelve, lo prueba como id de ProjectV2Item (un caller que
   * todavía pasa el id crudo del board, o el fast path de un delivery
   * `projects_v2_item`).
   */
  async getItemById(id: string): Promise<SourceItem | null> {
    const asIssue = await this.issues.getItemById(id).catch(() => null)
    if (asIssue) return this.attachProjectCounterpart(asIssue)
    const asProjectItem = await this.project.getItemById(id).catch(() => null)
    return asProjectItem ? this.normalizeBoardItem(asProjectItem) : null
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
      return match ? withBoardFields(issueItem, match) : issueItem
    } catch (err) {
      log.warn({ err, issueId: issueItem.id }, 'attachProjectCounterpart falló — sigo sin el board')
      return issueItem
    }
  }

  /** `GitHubProjectSource.getItemById` siempre resuelve a un issue real —
   *  `mapProjectItemNode` descarta drafts sin `content` (ver su doc) — así
   *  que `meta.issueId` está garantizado. Reasigna la identidad pública a la
   *  del issue y guarda el id real del board en `meta.projectItemId`. */
  private normalizeBoardItem(boardItem: SourceItem): SourceItem {
    const issueId = boardItem.meta?.issueId
    if (typeof issueId !== 'string') return boardItem
    return {
      ...boardItem,
      id: issueId,
      meta: { ...boardItem.meta, projectItemId: boardItem.id },
    }
  }

  /** El repo tiene que coincidir con el configurado, y si hay anchor label
   *  el item tiene que traerla — mismo criterio que decide qué issue es
   *  "tracked" del lado `github-issues`. Sin este chequeo, un delivery
   *  `projects_v2_item` de un board que cruza varios repos admitiría al
   *  pipeline issues que ni `getItems()` ni el polling verían nunca. */
  private isTracked(item: SourceItem): boolean {
    const repoName = item.meta?.repoName
    if (
      typeof repoName !== 'string' ||
      repoName.toLowerCase() !== this.issuesConfig.repo.toLowerCase()
    ) {
      return false
    }
    if (!this.issuesConfig.anchorLabel) return true
    const labels = (item.meta?.labels as string[] | undefined) ?? []
    return labels.includes(this.issuesConfig.anchorLabel)
  }

  /** `meta.projectItemId` es la marca propia (ver `normalizeBoardItem` /
   *  `withBoardFields`) de "este item tiene contraparte en el board". */
  private isOnBoard(item: { meta?: Record<string, unknown> }): boolean {
    return typeof item.meta?.projectItemId === 'string'
  }

  /** El id que `GitHubProjectSource` necesita para escribir es el del
   *  ProjectV2Item, no el del issue que este source expone públicamente —
   *  ver el comentario de la clase. Sólo hace falta para delegar una
   *  escritura; lectura (`toIssueItem`, comments, etc.) usa `item.meta`, no
   *  `item.id`, así que no necesita este swap. */
  private withBoardId<T extends { id: string; meta?: Record<string, unknown> }>(item: T): T {
    const projectItemId = item.meta?.projectItemId
    return typeof projectItemId === 'string' ? { ...item, id: projectItemId } : item
  }

  toIssueItem(item: SourceItem): IssueItem {
    return this.isOnBoard(item) ? this.project.toIssueItem(item) : this.issues.toIssueItem(item)
  }

  getTransitionManager(item: IssueItem, broadcast: BroadcastFn): TaskSource {
    return this.isOnBoard(item)
      ? this.project.getTransitionManager(this.withBoardId(item), broadcast)
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
      (this.project.getFields?.(opts) ?? Promise.resolve([])).catch((err) => {
        log.warn({ err }, 'getFields: el lado Project falló — sigo sólo con los del repo')
        return [] as SourceProjectField[]
      }),
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

  /** Chequea las DOS ubicaciones, no sólo la de la membresía actual del
   *  board: un link guardado en el campo del board mientras el issue estaba
   *  ahí sigue siendo válido si después lo sacaron (y viceversa, uno guardado
   *  en el body/PR antes de que el issue entrara al board). Perder la
   *  continuidad del hilo por un cambio de membresía sería peor que una
   *  lectura de más. */
  async getSlackThreadUrl(item: IssueItem): Promise<string | undefined> {
    if (this.isOnBoard(item)) {
      const fromBoard = await this.project.getSlackThreadUrl(item)
      if (fromBoard) return fromBoard
    }
    return this.issues.getSlackThreadUrl(item)
  }

  async setSlackThreadUrl(item: IssueItem, url: string): Promise<void> {
    // `withBoardId`: `GitHubProjectSource.setSlackThreadUrl` usa `item.id`
    // como id de ProjectV2Item para el `updateProjectV2ItemFieldValue` —
    // sin el swap, mandaría el node id del Issue (la identidad pública de
    // este source) y GitHub lo rechazaría.
    return this.isOnBoard(item)
      ? this.project.setSlackThreadUrl(this.withBoardId(item), url)
      : this.issues.setSlackThreadUrl(item, url)
  }

  async setItemField(itemId: string, field: string, value: string): Promise<void> {
    if (!this.project.setItemField) {
      throw new Error(`setItemField no soportado: '${field}' no es un campo del board`)
    }
    const item = await this.getItemById(itemId)
    const projectItemId = item?.meta?.projectItemId as string | undefined
    if (!projectItemId) {
      throw new Error(`setItemField no soportado: '${itemId}' no está en el board`)
    }
    await this.project.setItemField(projectItemId, field, value)
  }

  /** Crea el issue vía `github-issues` (labels/ancla) — no lo agrega al
   *  board automáticamente. Si el board lo espera agregado, agregalo desde
   *  GitHub; el próximo scan lo mergea solo. */
  async createItem(input: CreateItemInput): Promise<SourceItem> {
    return this.issues.createItem(input)
  }

  /**
   * `title`/`description` van SIEMPRE por `issues` — son el issue de
   * verdad, y `project.updateItem` sólo sabe editar un DRAFT propio (tira
   * `is not a draft issue` para cualquier issue real, board-tracked o no).
   * `type`/`repos`/`status` van por `project` cuando el item está en el
   * board (son sus campos), y si no por `issues` (sólo `status`, que ahí es
   * la label — `type`/`repos` no existen del lado issues y quedan sin
   * efecto, igual que hoy usando `GitHubIssueSource` solo).
   *
   * Re-lee con `getItemById` al final en vez de devolver lo que cualquiera
   * de los dos delegados retorna: es lo que garantiza la identidad estable
   * (`normalizeBoardItem`/`withBoardFields`) sin importar por dónde se
   * escribió.
   */
  async updateItem(id: string, patch: UpdateItemInput): Promise<SourceItem> {
    const item = await this.getItemById(id)
    if (!item) throw new Error(`Item '${id}' not found`)
    const projectItemId = item.meta?.projectItemId as string | undefined

    const { title, description, ...boardPatch } = patch
    if (title !== undefined || description !== undefined) {
      await this.issues.updateItem(id, { title, description })
    }
    const hasBoardEdits = Object.values(boardPatch).some((v) => v !== undefined)
    if (hasBoardEdits) {
      if (projectItemId) await this.project.updateItem(projectItemId, boardPatch)
      else await this.issues.updateItem(id, boardPatch)
    }

    const refreshed = await this.getItemById(id)
    if (!refreshed) throw new Error(`Item '${id}' desapareció después de updateItem`)
    return refreshed
  }

  // deleteItem NO se implementa a propósito: la fuente de verdad del set
  // rastreado es `issues`, y `GitHubIssueSource` no borra issues de GitHub
  // (no tiene sentido — cerrarlo es otra cosa, y no es lo que pide un
  // "delete"). Sacar el item sólo del board (lo único que `project.deleteItem`
  // puede hacer) no borraría nada: el issue seguiría abierto con su anchor
  // label y el próximo scan lo devolvería otra vez, ahora sin datos de
  // board — un "borrado" que se deshace solo. Omitir el método hace que la
  // ruta responda 501 en vez de simular un borrado que no ocurrió.

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

  /**
   * AND, no OR: `github-project`'s propio `matchesWebhook` es deliberadamente
   * laxo para deliveries `issues`/`issue_comment` (matchea por OWNER, no por
   * repo — un owner puede tener el issue en varios boards). Acá el set
   * tracked lo define `issues`, que SÍ filtra por repo exacto — dejar pasar
   * con un OR abriría este source a cualquier repo del mismo owner. Para un
   * delivery `projects_v2_item` (sin `repoFullName`), `issues.matchesWebhook`
   * ya falla abierto (`true`) por su propio diseño, así que el AND termina
   * gobernado por el chequeo preciso de `project` — no se pierde nada.
   */
  async matchesWebhook(hint: WebhookMatchHint): Promise<boolean> {
    const [fromIssues, fromProject] = await Promise.all([
      this.issues.matchesWebhook?.(hint) ?? Promise.resolve(true),
      this.project.matchesWebhook?.(hint) ?? Promise.resolve(true),
    ])
    return fromIssues && fromProject
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
   *     (ya trae nativos + board mergeados), filtrado por `isTracked` — un
   *     board puede cruzar varios repos y este source sólo rastrea uno.
   *   · `issues`/`issue_comment` — resuelto vía `getItemById` (confirma que
   *     `fromWebhookPayload` de verdad trajo un issue), enriquecido con el
   *     board si existe.
   * Sin delivery (nudge manual / fallback timer), o si lo de arriba no
   * resolvió nada tracked → scan completo mergeado.
   */
  private async resolveWebhookDelivery(delivery?: WebhookDelivery): Promise<SourceItem[]> {
    if (delivery) {
      const itemNodeId = (delivery.payload.projects_v2_item as { node_id?: unknown } | undefined)
        ?.node_id
      if (typeof itemNodeId === 'string') {
        const item = await this.project.getItemById(itemNodeId)
        if (item && this.isTracked(item)) return [this.normalizeBoardItem(item)]
      }
      const direct = fromWebhookPayload(delivery.payload)
      if (direct) {
        const issueItem = await this.issues.getItemById(direct.id)
        if (issueItem) return [await this.attachProjectCounterpart(issueItem)]
      }
    }
    return this.getItems({ refresh: true })
  }
}

/** El item del board reemplaza al del issue por completo salvo por dos
 *  cosas: la IDENTIDAD (`id`) sigue siendo la del issue — ver el comentario
 *  de la clase sobre por qué — y el `status`, que cae al de la label si el
 *  board no tiene Status seteado. El id real del board queda aparte en
 *  `meta.projectItemId`. */
function withBoardFields(issueItem: SourceItem, boardItem: SourceItem): SourceItem {
  return {
    ...boardItem,
    id: issueItem.id,
    status: boardItem.status || issueItem.status,
    meta: { ...boardItem.meta, projectItemId: boardItem.id },
  }
}

/** El item del board (con `issueId` en su `meta`) reemplaza al del issue
 *  cuando existe — ver `withBoardFields`. Exportada para poder testear el
 *  merge sin fakear las dos fuentes completas (que hablan GraphQL/REST de
 *  verdad). */
export function mergeByIssueId(issueItems: SourceItem[], projectItems: SourceItem[]): SourceItem[] {
  const byIssueId = new Map<string, SourceItem>()
  for (const p of projectItems) {
    const issueId = p.meta?.issueId
    if (typeof issueId === 'string') byIssueId.set(issueId, p)
  }
  return issueItems.map((i) => {
    const match = byIssueId.get(i.id)
    return match ? withBoardFields(i, match) : i
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
