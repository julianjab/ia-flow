import {
  FOCUS_MAX_CANDIDATES,
  FOCUS_MAX_CLUSTERS,
  FOCUS_MAX_PICKS,
  FOCUS_WHY_MAX,
  type TaskDispositionEntry,
  type TaskFocus,
  type TaskFocusCluster,
  type TaskFocusPick,
  memoize,
} from '@ia-flow/shared'
import type { SourceItem } from '../../domain/ports/IIssueManager.js'
import type { IStructuredCompletion } from '../../domain/ports/IStructuredCompletion.js'
import { createLogger } from '../../logger.js'
import {
  FOCUS_RESPONSE_SCHEMA,
  FOCUS_SYSTEM_PROMPT,
  FOCUS_TOOL_DESCRIPTION,
  FOCUS_TOOL_NAME,
} from './focus-prompt.js'

const log = createLogger('use-case:task-focus')

/**
 * El foco: qué mirar primero de lo que YA está ordenado.
 *
 * La división de trabajo con `GetTaskDispositionsUseCase` es la que sostiene
 * todo lo demás. Aquél decide *quién mueve la próxima pieza* y ordena el
 * bucket con reglas deterministas, explicables y testeables. Éste no toca ese
 * orden: lee las mismas filas y **las nombra** — que tres son la misma cosa,
 * que dos fallan por el mismo timeout, cuál se cierra en diez minutos.
 *
 * Dejar que el modelo reordenara habría costado las dos propiedades que hacen
 * usable la lista: que el orden se pueda explicar fila por fila, y que no se
 * mueva bajo el dedo entre dos cargas.
 *
 * Sólo mira el bucket `waiting-on-you`: los otros tres, por definición, no te
 * tocan, y pedirle al modelo que opine sobre ellos es pagar por texto que
 * contradice al orden de al lado.
 */

/** Lo mínimo que se necesita de la fuente. Interfaz angosta, como en
 *  `DispositionSource`: sólo el listado, y encima memoizado por la fuente. */
export interface FocusSource {
  getItems: (opts?: { refresh?: boolean }) => Promise<SourceItem[]>
}

/** Lo que el modelo ve de cada tarea. Todo sale de datos que el dispatch ya
 *  tenía en memoria: el foco no agrega ni un request contra la fuente. */
interface FocusCandidate {
  taskId: string
  title: string
  status: string
  repos?: string
  /** La razón determinista, textual. Trae el `failureClass`, el PR y su CI, y
   *  los intentos — que es de dónde sale casi todo lo que el modelo puede
   *  decir sin inventar. */
  reason: string
  unblocks: number
  waitingOnYouSince: string | null
}

export interface FocusDeps {
  completion: IStructuredCompletion
  /**
   * Las disposiciones, ya calculadas.
   *
   * Se inyecta en vez de importar el otro use-case para que este se pueda
   * testear con tres objetos literales, y para que el día que el foco se pida
   * junto al listado no haya que recalcularlas.
   */
  loadDispositions: (projectId: string, source: FocusSource) => Promise<TaskDispositionEntry[]>
  /** El interruptor, leído por llamada: el env se vuelca a `Bun.env` después
   *  de que el composition root se evaluó. */
  enabled: () => boolean
  now?: () => Date
}

/** Cuánto vale una inferencia sobre una lista que no cambió. Cinco minutos es
 *  el orden de magnitud de lo que tarda alguien en mirar la pantalla, irse y
 *  volver — abrir Tareas diez veces no son diez llamadas. */
const FOCUS_TTL_MS = 5 * 60_000

export class GetTaskFocusUseCase {
  constructor(private readonly deps: FocusDeps) {}

  /**
   * `null` cuando no hay nada que mostrar, y es deliberado que los tres
   * motivos —apagado, sin credencial, bucket vacío— colapsen en el mismo
   * valor: la UI hace lo mismo con los tres (no dibuja la card). Un fallo NO
   * cae acá: tira, y el estado degradado lo dibuja quien llama.
   */
  async execute(
    projectId: string,
    source: FocusSource,
    opts: { refresh?: boolean } = {},
  ): Promise<TaskFocus | null> {
    if (!this.deps.enabled()) {
      log.debug({ projectId }, 'foco apagado por configuración')
      return null
    }
    if (!this.deps.completion.isAvailable()) {
      log.debug({ projectId }, 'foco sin credencial')
      return null
    }

    const [dispositions, items] = await Promise.all([
      this.deps.loadDispositions(projectId, source),
      source.getItems(),
    ])
    const candidates = buildCandidates(dispositions, items)
    // Con una sola tarea esperándote no hay nada que priorizar ni que
    // agrupar, y la card sería una línea que repite la fila de abajo.
    if (candidates.length < 2) {
      log.debug({ projectId, candidates: candidates.length }, 'foco sin material')
      return null
    }

    return this.infer(fingerprint(projectId, candidates), candidates, opts.refresh === true)
  }

  /**
   * La llamada al modelo, cacheada por **huella del contenido**.
   *
   * La key no es el proyecto: es lo que había cuando se calculó (ids +
   * disposición + razón). Así una lista que no se movió sirve del cache, y una
   * que sí cambió recalcula sola, sin nadie que tenga que acordarse de
   * invalidar. `refresh` saltea la lectura y repuebla la misma entrada — es el
   * `reintentar` del estado degradado.
   */
  // Los tipos van explícitos: inferidos desde `key` se toman su lista de
  // argumentos como la del método, y `bypass` deja de compilar.
  @memoize<[string, FocusCandidate[], boolean], Promise<TaskFocus | null>>({
    ttlMs: FOCUS_TTL_MS,
    key: (fp) => fp,
    bypass: (_fp, _candidates, refresh) => refresh,
  })
  private async infer(
    fp: string,
    candidates: FocusCandidate[],
    _refresh: boolean,
  ): Promise<TaskFocus | null> {
    const t0 = Date.now()
    const raw = await this.deps.completion.complete({
      system: FOCUS_SYSTEM_PROMPT,
      user: renderCandidates(candidates),
      schema: FOCUS_RESPONSE_SCHEMA,
      toolName: FOCUS_TOOL_NAME,
      toolDescription: FOCUS_TOOL_DESCRIPTION,
      maxTokens: 2000,
      scope: { scope: 'task-focus', candidates: candidates.length },
    })
    if (!raw) {
      // El modelo contestó pero no llenó la tool. No es un fallo de red: no se
      // reintenta solo, y una card vacía es peor que ninguna.
      log.warn({ fp, ms: Date.now() - t0 }, 'foco: el modelo no llenó la tool')
      return null
    }

    const focus = sanitize(raw, candidates, (this.deps.now?.() ?? new Date()).toISOString())
    log.info(
      {
        fp,
        ms: Date.now() - t0,
        picks: focus?.picks.length ?? 0,
        clusters: focus?.clusters.length ?? 0,
      },
      'foco calculado',
    )
    return focus
  }
}

// ─── Puro, de acá para abajo ───────────────────────────────────────────────

/** Las tareas que te esperan, en el orden en que el server ya las ordenó. */
function buildCandidates(
  dispositions: TaskDispositionEntry[],
  items: SourceItem[],
): FocusCandidate[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const out: FocusCandidate[] = []
  for (const d of dispositions) {
    if (d.disposition !== 'waiting-on-you') continue
    const item = byId.get(d.taskId)
    // Una disposición sin su ítem es una fila que la pantalla tampoco dibuja.
    if (!item) continue
    out.push({
      taskId: d.taskId,
      title: item.title,
      status: item.status,
      ...(item.repos ? { repos: item.repos } : {}),
      reason: d.reason,
      unblocks: d.unblocks,
      waitingOnYouSince: d.waitingOnYouSince,
    })
    if (out.length >= FOCUS_MAX_CANDIDATES) break
  }
  return out
}

/**
 * La huella de "esto es lo que había".
 *
 * Incluye la razón y no sólo el id: una tarea cuyo run pasó de `corriendo` a
 * `falló 3×` es material nuevo para el modelo aunque la lista tenga los mismos
 * ids. No incluye la antigüedad, que cambia sola con el reloj y recalcularía
 * cada minuto sin que nada haya pasado.
 */
function fingerprint(projectId: string, candidates: FocusCandidate[]): string {
  const body = candidates.map((c) => `${c.taskId}|${c.reason}|${c.unblocks}`).join('\n')
  return `${projectId}\n${body}`
}

function renderCandidates(candidates: FocusCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const parts = [
      `${i + 1}. taskId: ${c.taskId}`,
      `   título: ${c.title}`,
      `   status: ${c.status}`,
      `   razón: ${c.reason}`,
    ]
    if (c.repos) parts.push(`   repos: ${c.repos}`)
    if (c.unblocks > 0) parts.push(`   traba a ${c.unblocks} tarea(s)`)
    if (c.waitingOnYouSince) parts.push(`   esperándote desde: ${c.waitingOnYouSince}`)
    return parts.join('\n')
  })
  return [
    `Estas ${candidates.length} tareas te esperan, ya ordenadas por urgencia mecánica:`,
    '',
    ...lines,
  ].join('\n')
}

/**
 * Lo que vuelve del modelo, recortado a lo que el contrato promete.
 *
 * El gate que importa es el primero: **un `taskId` que no estaba en la lista
 * se descarta**. Sin eso, una alucinación pinta arriba de la pantalla una
 * tarea que no existe, en la única parte de la app que el usuario no puede
 * verificar de un vistazo.
 */
function sanitize(
  raw: Record<string, unknown>,
  candidates: FocusCandidate[],
  computedAt: string,
): TaskFocus | null {
  const known = new Set(candidates.map((c) => c.taskId))
  const headline = typeof raw.headline === 'string' ? raw.headline.trim() : ''
  // Sin headline no hay card: es lo único que se ve colapsada, que es el
  // estado por default.
  if (!headline) return null

  const seen = new Set<string>()
  const picks: TaskFocusPick[] = []
  for (const p of Array.isArray(raw.picks) ? raw.picks : []) {
    const pick = p as Record<string, unknown>
    const taskId = typeof pick.taskId === 'string' ? pick.taskId : ''
    if (!known.has(taskId) || seen.has(taskId)) continue
    const why = typeof pick.why === 'string' ? pick.why.trim() : ''
    if (!why) continue
    seen.add(taskId)
    picks.push({
      taskId,
      why: clamp(why, FOCUS_WHY_MAX),
      // Ante cualquier otra cosa, `deep`: prometer que algo es rápido y que no
      // lo sea cuesta más que lo contrario.
      effort: pick.effort === 'quick' ? 'quick' : 'deep',
    })
    if (picks.length >= FOCUS_MAX_PICKS) break
  }
  if (!picks.length) return null

  const clusters: TaskFocusCluster[] = []
  for (const c of Array.isArray(raw.clusters) ? raw.clusters : []) {
    const cluster = c as Record<string, unknown>
    const label = typeof cluster.label === 'string' ? cluster.label.trim() : ''
    const taskIds = (Array.isArray(cluster.taskIds) ? cluster.taskIds : [])
      .filter((id): id is string => typeof id === 'string' && known.has(id))
      .filter((id, i, arr) => arr.indexOf(id) === i)
    // Un "grupo" de una tarea no agrupa nada, y ocupa la misma fila que uno
    // que sí dice algo.
    if (!label || taskIds.length < 2) continue
    clusters.push({ label, taskIds })
    if (clusters.length >= FOCUS_MAX_CLUSTERS) break
  }

  return { headline, picks, clusters, computedAt }
}

/** Corta en el último espacio antes del tope: media palabra se lee como un
 *  error de la app, no como un texto largo. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}
