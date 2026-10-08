// Una decisión de la bandeja como la dibuja la cola: su fila (tipo, verbo, razones, antigüedad,
// botón) y su detalle. Y el agrupado de los merges y los PRDs. Puro, sin Vue.

import type { InboxItem } from '@ia-flow/shared'
import { type Age, ageOf } from '@/features/inbox/queue/age'
import { withEpic } from '@/features/inbox/queue/epics'
import { groupSummary, oldestAge } from '@/features/inbox/queue/groupTitle'
import {
  actionOf,
  primaryOf,
  type QueueAction,
  type QueueTone,
  type QueueType,
  TYPE_META,
  typeOf,
  verbOf,
} from '@/features/inbox/queue/kinds'
import { shortRef } from '@/features/inbox/queue/shortRef'

/** Cuántas razones lleva «Lo primero» y cuántas una fila de «Después». */
export const FIRST_REASONS = 3
export const ROW_REASONS = 2

export interface Reason {
  text: string
  tone?: 'hot' | 'warn' | 'bad'
  /** El texto entero cuando `text` va recortado (el título de una épica): su `title`. */
  full?: string
}

/** Lo que se ve al expandir: el porqué, una sola vez cada cosa. */
export interface EntryDetail {
  /** «Qué pasó»: texto humano (context, si no why). */
  happened: string
  /** Lo que dijo el agente (texto de modelo: ✦ en --ai). */
  said?: string
  /** Quién lo dijo: «El implementer dice». */
  saidBy?: string
  /** Cuándo lo pensó (ISO): el cierre de su corrida, o su arranque si sigue. */
  saidAt?: string
  /** El error crudo, una sola vez, para «Detalle técnico». */
  tech?: string
}

interface RowLook {
  rank: number
  type: QueueType
  glyph: string
  tone: QueueTone
  verb: string
  title: string
  reasons: Reason[]
  age: Age
}

/** Una decisión sola. */
export interface QueueEntry extends RowLook {
  kind: 'single'
  ref: string
  /** `seller#4281`. */
  short: string
  url: string
  action?: QueueAction
  /** Las demás acciones ofrecidas: terciarias (ghost). */
  secondary: QueueAction[]
  detail: EntryDetail
  item: InboxItem
}

/** Varias decisiones del mismo tipo agrupable: «Mergear 2 PRs». */
export interface QueueGroup extends RowLook {
  kind: 'group'
  /** Estable entre refrescos: el tipo. */
  key: string
  /** «Mergear los 2…»: ejecuta la acción de cada hija, en serie. */
  action: QueueAction
  children: QueueEntry[]
}

export type QueueRow = QueueEntry | QueueGroup

/** El tono de una razón que manda el runner (`reasons`, texto plano): lo que acerca a Done o
 *  destraba es `hot`; una falla del runner, `bad`; la del agente, `warn`. */
export function reasonTone(text: string): Reason['tone'] {
  if (/^(a un merge|destraba)/.test(text)) return 'hot'
  if (text.startsWith('falló el runner')) return 'bad'
  if (text.startsWith('falló')) return 'warn'
  return undefined
}

/**
 * Las razones, en este orden de fuentes: los chips del dashboard; si no hay, las `reasons` que
 * manda el runner con `/api/inbox` (en su orden); si tampoco, lo que se deduce de la tarea.
 */
export function reasonsOf(item: InboxItem): Reason[] {
  if (item.chips && item.chips.length > 0) return item.chips.map((c) => ({ ...c }))
  if (item.reasons && item.reasons.length > 0)
    return item.reasons.map((text) => {
      const tone = reasonTone(text)
      return tone ? { text, tone } : { text }
    })
  const out: Reason[] = []
  if (item.unlocks) out.push({ text: `destraba ${item.unlocks}`, tone: 'hot' })
  const blocker = item.blocked_by?.[0]
  if (blocker) out.push({ text: `espera ${shortRef(blocker)}`, tone: 'warn' })
  const failure = item.execution?.failure
  if (failure && item.group === 'fail')
    out.push(
      failure.by === 'runtime'
        ? { text: 'falló el runner, no el agente', tone: 'bad' }
        : { text: 'lo cortó el agente', tone: 'warn' },
    )
  return out
}

export function detailOf(item: InboxItem): EntryDetail {
  const tech = item.execution?.failure?.message
  const agent = item.execution?.agent_id
  const happened = item.context || item.why
  return {
    happened: happened === tech ? '' : happened,
    ...(item.agent_said && item.agent_said !== tech
      ? {
          said: item.agent_said,
          saidBy: agent ? `El ${agent} dice` : 'El agente dice',
          saidAt: item.execution?.closed_at ?? item.execution?.started_at ?? item.since,
        }
      : {}),
    ...(tech ? { tech } : {}),
  }
}

export function entryOf(
  item: InboxItem,
  rank: number,
  now: number,
  maxReasons: number,
): QueueEntry {
  const type = typeOf(item)
  const meta = TYPE_META[type]
  const primary = primaryOf(item)
  const defs = item.action_defs ?? []
  return {
    kind: 'single',
    rank,
    type,
    glyph: meta.glyph,
    tone: meta.tone,
    verb: verbOf(item),
    title: item.title,
    reasons: withEpic(reasonsOf(item), [item.epic], maxReasons),
    age: ageOf(item.since, now),
    ref: item.ref,
    short: shortRef(item.ref),
    url: item.url,
    ...(primary ? { action: actionOf(primary, defs) } : {}),
    secondary: item.actions.filter((id) => id !== primary).map((id) => actionOf(id, defs)),
    detail: detailOf(item),
    item,
  }
}

/** Los tipos que se agrupan con ≥2 y la acción que corre el grupo. */
const GROUPABLE: Partial<Record<'merge' | 'prd', { action: string; verb: (n: number) => string }>> =
  {
    merge: { action: 'merge', verb: (n) => `Mergear ${n} PRs` },
    prd: { action: 'approve_prd', verb: (n) => `Aprobar ${n} PRDs` },
  }

const GROUP_LABEL: Record<string, (n: number) => string> = {
  merge: (n) => `Mergear los ${n}…`,
  approve_prd: (n) => `Aprobar los ${n}…`,
}

const isGroupable = (type: QueueType): type is 'merge' | 'prd' => type in GROUPABLE

function groupOf(type: 'merge' | 'prd', children: QueueEntry[]): QueueGroup {
  const spec = GROUPABLE[type]!
  const meta = TYPE_META[type]
  const n = children.length
  const seen = new Set<string>()
  const reasons = children
    .flatMap((c) => reasonsOf(c.item))
    .filter((r) => !seen.has(r.text) && seen.add(r.text))
  return {
    kind: 'group',
    key: `group:${type}`,
    rank: 0,
    type,
    glyph: meta.glyph,
    tone: meta.tone,
    verb: spec.verb(n),
    title: groupSummary(
      type,
      children.map((c) => c.item),
    ),
    reasons: withEpic(
      reasons,
      children.map((c) => c.item.epic),
      ROW_REASONS,
    ),
    age: oldestAge(children.map((c) => c.age)),
    action: { id: spec.action, label: GROUP_LABEL[spec.action]!(n), confirms: true },
    children,
  }
}

/**
 * Junta en una fila las decisiones de un tipo agrupable (merge, prd) que ofrecen la acción del
 * grupo, si son dos o más. La fila queda donde estaba la primera; después se renumera desde
 * `firstRank`.
 */
export function groupRows(entries: readonly QueueEntry[], firstRank: number): QueueRow[] {
  const members = new Map<QueueType, QueueEntry[]>()
  for (const entry of entries) {
    if (!isGroupable(entry.type) || entry.action?.id !== GROUPABLE[entry.type]?.action) continue
    members.set(entry.type, [...(members.get(entry.type) ?? []), entry])
  }
  const rows: QueueRow[] = []
  for (const entry of entries) {
    const group = members.get(entry.type)
    if (!group || group.length < 2 || !group.includes(entry) || !isGroupable(entry.type))
      rows.push(entry)
    else if (group[0] === entry) rows.push(groupOf(entry.type, group))
  }
  return rows.map((row, i) => ({ ...row, rank: firstRank + i }))
}
