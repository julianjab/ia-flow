// «Dónde se traba cada épica»: de las decisiones de la cola, una entrada por épica —su avance y
// la decisión suya que está primera en la cola, la que la destraba—, y el chip «épica X d/t» de
// cada fila. Puro, sin Vue.

import type { InboxItem, TaskEpic } from '@ia-flow/shared'
import type { Reason } from '@/features/inbox/queue/entries'
import { type QueueType, typeOf } from '@/features/inbox/queue/kinds'
import { refUrl } from '@/features/inbox/queue/shortRef'

export interface EpicLine {
  /** `owner/repo#n` de la épica. */
  ref: string
  title: string
  /** El issue de la épica; un ref sin forma `owner/repo#n` no tiene link. */
  url?: string
  done: number
  total: number
  /** Avance 0–100, para la barra. */
  pct: number
  /** «#4281 espera tu merge»: la decisión de esta épica que va primera en la cola. */
  neck: string
  /** El ref de esa decisión. */
  blockedAt: string
}

/** Lo que la persona tiene que dar, por tipo de decisión: «espera tu merge». */
const WAITS_FOR: Record<QueueType, string> = {
  merge: 'merge',
  prd: 'aprobación del PRD',
  review: 're-review',
  answer: 'respuesta',
  relaunch: 'relanzada',
  fail: 'reintento',
  other: 'decisión',
}

const isDecision = (item: InboxItem) => item.group === 'need' || item.group === 'fail'

/** `owner/repo#4281` → `#4281`. */
const hashOf = (ref: string) => {
  const hash = ref.lastIndexOf('#')
  return hash < 0 ? ref : ref.slice(hash)
}

/** «#4281 espera tu merge». */
export function neckOf(item: Pick<InboxItem, 'ref' | 'kind' | 'group'>): string {
  return `${hashOf(item.ref)} espera tu ${WAITS_FOR[typeOf(item)]}`
}

const pctOf = (epic: TaskEpic) =>
  epic.total > 0 ? Math.round((Math.min(epic.done, epic.total) / epic.total) * 100) : 0

/**
 * Una entrada por épica distinta entre las decisiones (`need` + `fail`), en el orden de su primera
 * decisión en la cola. `items` viene en el orden de la cola (el del dashboard o el del runner).
 */
export function epicsOf(items: readonly InboxItem[]): EpicLine[] {
  const seen = new Set<string>()
  const out: EpicLine[] = []
  for (const item of items) {
    const epic = item.epic
    if (!epic || !isDecision(item) || seen.has(epic.ref)) continue
    seen.add(epic.ref)
    const url = refUrl(epic.ref)
    out.push({
      ref: epic.ref,
      title: epic.title,
      ...(url ? { url } : {}),
      done: epic.done,
      total: epic.total,
      pct: pctOf(epic),
      neck: neckOf(item),
      blockedAt: item.ref,
    })
  }
  return out
}

/** El chip de la épica de una tarea: «épica Filtros del listado 3/5». */
export function epicReason(epic: TaskEpic): Reason {
  return { text: `épica ${epic.title} ${epic.done}/${epic.total}` }
}

/** Agrega el chip de la épica al final, sólo si queda lugar y no está repetido. */
export function withEpic(
  reasons: readonly Reason[],
  epics: ReadonlyArray<TaskEpic | undefined>,
  max: number,
): Reason[] {
  const out = reasons.slice(0, max)
  for (const epic of epics) {
    if (out.length >= max) break
    if (!epic) continue
    const chip = epicReason(epic)
    if (!out.some((r) => r.text === chip.text)) out.push(chip)
  }
  return out
}
