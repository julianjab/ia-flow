// Cómo se ordena «Para mí» para quien mira: el orden que elige (el del runner, el más reciente o el
// más viejo primero), las que fijó arriba y las que pospuso. Toca sólo las decisiones (`need` y
// `fail`): lo que corre o espera sigue como llega. Puro: `now` se inyecta.

import type { InboxItem } from '@ia-flow/shared'

export type SortMode = 'priority' | 'recent' | 'oldest'

export const SORT_MODES: readonly { id: SortMode; label: string }[] = [
  { id: 'priority', label: 'Prioridad' },
  { id: 'recent', label: 'Más reciente' },
  { id: 'oldest', label: 'Más antigua' },
]

/** Una tarea pospuesta: vuelve cuando su huella cambia o, si tiene plazo, cuando vence. */
export interface Snooze {
  ref: string
  /** La huella al posponerla (`fingerprintOf`). */
  fp: string
  /** ISO. Sin plazo: sólo vuelve cuando cambia algo. */
  until?: string
}

export interface ArrangeInput {
  items: readonly InboxItem[]
  sort: SortMode
  /** Refs fijadas, en el orden en que se fijaron. */
  pins: readonly string[]
  snoozes: readonly Snooze[]
  now: number
}

export interface Arranged {
  /** Los items con las decisiones ya ordenadas y sin las pospuestas. */
  items: InboxItem[]
  /** Las decisiones pospuestas que siguen pospuestas, en el orden en que se pospusieron. */
  snoozed: InboxItem[]
  /** Las fijadas que siguen en la cola (una que dejó de necesitarte se desfija). */
  pinned: string[]
  /** Las pospuestas que siguen vigentes (las que volvieron o ya no están, afuera). */
  activeSnoozes: Snooze[]
}

const isDecision = (item: InboxItem) => item.group === 'need' || item.group === 'fail'

/** Lo que tiene que cambiar para que una pospuesta vuelva sola: la columna, desde cuándo está así,
 *  su corrida, su PR y qué te pide. Un comentario suelto no la trae de vuelta. */
export function fingerprintOf(item: InboxItem): string {
  return [
    item.status ?? '',
    item.since,
    item.execution?.id ?? '',
    item.execution?.status ?? '',
    item.pr?.number ?? '',
    item.kind,
  ].join('|')
}

/** Si la pospuesta sigue pospuesta frente a cómo está la tarea ahora. */
export function stillSnoozed(snooze: Snooze, item: InboxItem, now: number): boolean {
  if (snooze.fp !== fingerprintOf(item)) return false
  return !snooze.until || Date.parse(snooze.until) > now
}

const sinceOf = (item: InboxItem) => Date.parse(item.since) || 0

export function arrange(input: ArrangeInput): Arranged {
  const { items, sort, pins, snoozes, now } = input
  const byRef = new Map(items.filter(isDecision).map((item) => [item.ref, item]))

  const activeSnoozes = snoozes.filter((s) => {
    const item = byRef.get(s.ref)
    return item !== undefined && stillSnoozed(s, item, now)
  })
  const hidden = new Set(activeSnoozes.map((s) => s.ref))
  const pinned = pins.filter((ref) => byRef.has(ref) && !hidden.has(ref))
  const pinRank = new Map(pinned.map((ref, i) => [ref, i]))

  const decisions = items.filter((item) => isDecision(item) && !hidden.has(item.ref))
  const position = new Map(decisions.map((item, i) => [item.ref, i]))
  const ordered = [...decisions].sort((a, b) => {
    const pa = pinRank.get(a.ref)
    const pb = pinRank.get(b.ref)
    if (pa !== undefined || pb !== undefined) return (pa ?? Infinity) - (pb ?? Infinity)
    if (sort === 'recent') return sinceOf(b) - sinceOf(a)
    if (sort === 'oldest') return sinceOf(a) - sinceOf(b)
    return (position.get(a.ref) ?? 0) - (position.get(b.ref) ?? 0)
  })

  return {
    items: [...ordered, ...items.filter((item) => !isDecision(item))],
    snoozed: activeSnoozes.flatMap((s) => byRef.get(s.ref) ?? []),
    pinned,
    activeSnoozes,
  }
}

/** Los plazos de «Posponer»: `null` = hasta que cambie algo. */
export const SNOOZE_CHOICES: readonly { id: string; label: string; ms: number | null }[] = [
  { id: 'change', label: 'Hasta que cambie algo', ms: null },
  { id: 'day', label: '1 día', ms: 24 * 3600_000 },
  { id: 'week', label: '1 semana', ms: 7 * 24 * 3600_000 },
]

export function snoozeOf(item: InboxItem, until: number | null): Snooze {
  return {
    ref: item.ref,
    fp: fingerprintOf(item),
    ...(until !== null ? { until: new Date(until).toISOString() } : {}),
  }
}
