// La línea de una fila agrupada («Aprobar 2 PRDs»): un resumen corto de lo que comparten sus
// hijas, no sus títulos pegados —esos van en el detalle desplegado—. Y la antigüedad del grupo, la
// de la hija que más lleva esperando. Puro, sin Vue.

import type { InboxItem } from '@ia-flow/shared'
import type { Age } from '@/features/inbox/queue/age'

type Child = Pick<InboxItem, 'status' | 'labels' | 'blocked_by'>

const WORDS = [
  '',
  'una',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
]

/** `2` → `dos`; de once en adelante, la cifra. */
export function countWord(n: number): string {
  return WORDS[n] && n > 1 ? (WORDS[n] as string) : String(n)
}

/** El status que comparten todas, o `undefined` si difieren (o alguna no lo trae). */
function sharedStatus(children: readonly Child[]): string | undefined {
  const first = children[0]?.status
  return first && children.every((c) => c.status === first) ? first : undefined
}

/** «y sin bloqueos» / «· 1 con bloqueos»: lo que se sabe de sus prerrequisitos. */
function blockersOf(children: readonly Child[]): { none: boolean; some: number } {
  const some = children.filter((c) => (c.blocked_by?.length ?? 0) > 0).length
  return { none: some === 0, some }
}

/**
 * El resumen de un grupo de PRDs o de merges: «Los dos están en Refined y sin bloqueos», «Los
 * tres tienen la aprobación del reviewer y sin bloqueos». Sólo afirma lo que traen los datos: un
 * status distinto entre hijas no se nombra, y la aprobación del reviewer sale del label
 * `reviewed`, no se supone.
 */
export function groupSummary(type: 'merge' | 'prd', children: readonly Child[]): string {
  const n = countWord(children.length)
  const { none, some } = blockersOf(children)
  const tail = none ? ' y sin bloqueos' : ` · ${some} con bloqueos`
  if (type === 'prd') {
    const status = sharedStatus(children)
    return status ? `Los ${n} están en ${status}${tail}` : `Los ${n} esperan tu aprobación${tail}`
  }
  const reviewed = children.every((c) => c.labels.includes('reviewed'))
  return reviewed
    ? `Los ${n} tienen la aprobación del reviewer${tail}`
    : `Los ${n} esperan tu merge${tail}`
}

/** La antigüedad del grupo: la de la hija más vieja; una fecha que no parsea no compite. */
export function oldestAge(ages: readonly Age[]): Age {
  const dated = ages.filter((age) => age.text && !Number.isNaN(Date.parse(age.iso)))
  if (dated.length === 0) return ages[0] ?? { text: '', old: false, iso: '' }
  return dated.reduce((a, b) => (Date.parse(b.iso) < Date.parse(a.iso) ? b : a))
}
