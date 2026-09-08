import {
  memoize,
  TASK_GROUPS_MAX_CANDIDATES,
  type TaskDispositionEntry,
  type TaskFocusCluster,
  type TaskGroups,
} from '@ia-flow/shared'
import type { SourceItem } from '../../domain/ports/IIssueManager.js'
import type { IStructuredCompletion } from '../../domain/ports/IStructuredCompletion.js'
import { createLogger } from '../../logger.js'
import type { FocusSource } from './GetTaskFocusUseCase.js'
import {
  TASK_GROUPS_RESPONSE_SCHEMA,
  TASK_GROUPS_SYSTEM_PROMPT,
  TASK_GROUPS_TOOL_DESCRIPTION,
  TASK_GROUPS_TOOL_NAME,
} from './task-groups-prompt.js'

const log = createLogger('use-case:task-groups')

/**
 * Los grupos por tema: el bucket `waiting-on-you` ENTERO, agrupado para que el
 * barrido lea temas juntos en vez de filas sueltas.
 *
 * Hermano de `GetTaskFocusUseCase`, no el mismo dato: el foco es una tarjeta
 * advisory de 2-3 picks sobre un recorte chico (`FOCUS_MAX_CANDIDATES = 15`);
 * esto cubre todo el bucket (hasta `TASK_GROUPS_MAX_CANDIDATES`). Comparten
 * mecánica —Haiku vía `IStructuredCompletion`, cache por fingerprint, degradar
 * a la lista plana sin credencial— pero son dos llamadas y dos interruptores
 * independientes: agrupar 60 tareas cuesta más tokens que elegir 3, y un
 * operador puede querer uno sin el otro.
 *
 * **No reordena las FILAS.** El orden de cada candidato es el que ya calculó
 * `compareWithinBucket` (vía `loadDispositions`); lo único que este caso de
 * uso decide es qué grupo va primero, y lo decide por la posición del
 * integrante mejor ubicado — nunca lo decide el modelo.
 */

/** Lo que el modelo ve de cada tarea. Mismo recorte que el foco. */
interface GroupCandidate {
  taskId: string
  title: string
  status: string
  repos?: string
  reason: string
}

export interface TaskGroupsDeps {
  completion: IStructuredCompletion
  /** Se inyecta para no recalcular disposiciones si ya se pidieron — mismo
   *  motivo que en `GetTaskFocusUseCase`. */
  loadDispositions: (projectId: string, source: FocusSource) => Promise<TaskDispositionEntry[]>
  enabled: () => boolean
  now?: () => Date
}

const TASK_GROUPS_TTL_MS = 5 * 60_000

export class GetTaskGroupsUseCase {
  constructor(private readonly deps: TaskGroupsDeps) {}

  /** `null` cuando no hay nada que agrupar: apagado, sin credencial, o menos
   *  de dos candidatos. Un fallo de la llamada tira — el estado degradado lo
   *  decide quien llama, igual que el foco. */
  async execute(
    projectId: string,
    source: FocusSource,
    opts: { refresh?: boolean } = {},
  ): Promise<TaskGroups | null> {
    if (!this.deps.enabled()) {
      log.debug({ projectId }, 'grupos apagados por configuración')
      return null
    }
    if (!this.deps.completion.isAvailable()) {
      log.debug({ projectId }, 'grupos sin credencial')
      return null
    }

    const [dispositions, items] = await Promise.all([
      this.deps.loadDispositions(projectId, source),
      source.getItems(),
    ])
    const candidates = buildCandidates(dispositions, items)
    if (candidates.length < 2) {
      log.debug({ projectId, candidates: candidates.length }, 'grupos sin material')
      return null
    }

    return this.infer(fingerprint(projectId, candidates), candidates, opts.refresh === true)
  }

  @memoize<[string, GroupCandidate[], boolean], Promise<TaskGroups | null>>({
    ttlMs: TASK_GROUPS_TTL_MS,
    key: (fp) => fp,
    bypass: (_fp, _candidates, refresh) => refresh,
  })
  private async infer(
    fp: string,
    candidates: GroupCandidate[],
    _refresh: boolean,
  ): Promise<TaskGroups | null> {
    const t0 = Date.now()
    const raw = await this.deps.completion.complete({
      system: TASK_GROUPS_SYSTEM_PROMPT,
      user: renderCandidates(candidates),
      schema: TASK_GROUPS_RESPONSE_SCHEMA,
      toolName: TASK_GROUPS_TOOL_NAME,
      toolDescription: TASK_GROUPS_TOOL_DESCRIPTION,
      maxTokens: 3000,
      scope: { scope: 'task-groups', candidates: candidates.length },
    })
    if (!raw) {
      log.warn({ fp, ms: Date.now() - t0 }, 'grupos: el modelo no llenó la tool')
      return null
    }

    const groups = sanitize(raw, candidates)
    const result: TaskGroups = {
      groups,
      computedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    }
    log.info({ fp, ms: Date.now() - t0, groups: groups.length }, 'grupos calculados')
    return result
  }
}

// ─── Puro, de acá para abajo ───────────────────────────────────────────────

function buildCandidates(
  dispositions: TaskDispositionEntry[],
  items: SourceItem[],
): GroupCandidate[] {
  const byId = new Map(items.map((i) => [i.id, i]))
  const out: GroupCandidate[] = []
  for (const d of dispositions) {
    if (d.disposition !== 'waiting-on-you') continue
    const item = byId.get(d.taskId)
    if (!item) continue
    out.push({
      taskId: d.taskId,
      title: item.title,
      status: item.status,
      ...(item.repos ? { repos: item.repos } : {}),
      reason: d.reason,
    })
    if (out.length >= TASK_GROUPS_MAX_CANDIDATES) break
  }
  return out
}

function fingerprint(projectId: string, candidates: GroupCandidate[]): string {
  const body = candidates.map((c) => `${c.taskId}|${c.reason}`).join('\n')
  return `${projectId}\n${body}`
}

function renderCandidates(candidates: GroupCandidate[]): string {
  const lines = candidates.map((c, i) => {
    const parts = [
      `${i + 1}. taskId: ${c.taskId}`,
      `   título: ${c.title}`,
      `   status: ${c.status}`,
      `   razón: ${c.reason}`,
    ]
    if (c.repos) parts.push(`   repos: ${c.repos}`)
    return parts.join('\n')
  })
  return [
    `Estas ${candidates.length} tareas te esperan, ya ordenadas por urgencia mecánica:`,
    '',
    ...lines,
  ].join('\n')
}

/**
 * Lo que vuelve del modelo, recortado a lo que el contrato promete, y
 * REORDENADO — el modelo nombra los grupos, no decide cuál va primero.
 *
 * Un `taskId` desconocido se descarta (misma razón que el foco: una
 * alucinación no puede pintar una tarea que no existe). Una tarea que el
 * modelo puso en dos grupos se queda en el PRIMERO que la nombra —recorriendo
 * los grupos en el orden en que el modelo los devolvió— y desaparece del
 * resto: una tarea en dos secciones a la vez confundiría más de lo que ayuda.
 */
function sanitize(raw: Record<string, unknown>, candidates: GroupCandidate[]): TaskFocusCluster[] {
  const known = new Set(candidates.map((c) => c.taskId))
  const positionOf = new Map(candidates.map((c, i) => [c.taskId, i]))
  const claimed = new Set<string>()

  const groups: TaskFocusCluster[] = []
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    const group = g as Record<string, unknown>
    const label = typeof group.label === 'string' ? group.label.trim() : ''
    if (!label) continue
    const taskIds = (Array.isArray(group.taskIds) ? group.taskIds : [])
      .filter((id): id is string => typeof id === 'string' && known.has(id) && !claimed.has(id))
      .filter((id, i, arr) => arr.indexOf(id) === i)
    if (taskIds.length < 2) continue
    for (const id of taskIds) claimed.add(id)
    groups.push({ label, taskIds })
  }

  // El orden de los grupos: por la posición del integrante mejor ubicado en
  // el orden ya calculado — el mismo que gobierna la lista de abajo. No es
  // una opinión nueva sobre urgencia, es la que ya existía.
  groups.sort((a, b) => bestPosition(a, positionOf) - bestPosition(b, positionOf))
  return groups
}

function bestPosition(cluster: TaskFocusCluster, positionOf: Map<string, number>): number {
  let best = Number.POSITIVE_INFINITY
  for (const id of cluster.taskIds) {
    const pos = positionOf.get(id)
    if (pos !== undefined && pos < best) best = pos
  }
  return best
}
