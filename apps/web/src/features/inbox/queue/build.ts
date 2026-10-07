// La bandeja como cola de decisiones: de los items (ya ordenados por el dashboard, o como los
// manda un runner viejo) a lo que se dibuja — el titular, «Lo primero», «Después» numerado y
// agrupado, el filtro por tipo, el pipeline, lo que corre y lo que le das. Puro: `now` se inyecta.

import type { InboxItem, RunnerCapacity } from '@ia-flow/shared'
import { type Age, ageOf } from '@/features/inbox/queue/age'
import {
  entryOf,
  FIRST_REASONS,
  groupRows,
  type QueueEntry,
  type QueueRow,
  ROW_REASONS,
} from '@/features/inbox/queue/entries'
import { type EpicLine, epicsOf } from '@/features/inbox/queue/epics'
import {
  actionOf,
  type QueueAction,
  type QueueType,
  TYPE_META,
  TYPE_ORDER,
} from '@/features/inbox/queue/kinds'
import { shortRef } from '@/features/inbox/queue/shortRef'
import type { DashboardView, HygieneLine } from '@/features/inbox/view/decide'

/** El filtro por tipo aparece con MÁS de estas decisiones. */
export const FILTER_THRESHOLD = 4

export interface Headline {
  /** Filas de la cola: «Lo primero» + «Después» (un grupo cuenta una). */
  decisions: number
  /** Tareas detrás de esas decisiones (las de un grupo, cada una). */
  tasks: number
  /** Cuántas de esas tareas son una falla. 0 → «✓ nada falló». */
  failed: number
}

export interface QueueFilter {
  /** `null` = «Todas». */
  type: QueueType | null
  label: string
  count: number
  pressed: boolean
}

export interface PipelineSummary {
  running: number
  waiting: number
  /** Lugares libres; sin tope (o runner viejo), ausente. */
  free?: number
  max?: number
  /** De dónde salen: la capacidad del runner (ejecuciones) o, sin ella, las tarjetas. */
  source: 'capacity' | 'items'
}

export interface RunningEntry {
  ref: string
  short: string
  url: string
  title: string
  /** El agente (o la pipeline) que corre. */
  agent: string
  age: Age
  /** «Detener…», si el runner la ofrece. */
  stop?: QueueAction
}

export interface FeedLine {
  ref: string
  short: string
  url: string
  title: string
  action?: { id: string; label: string }
}

export interface FeedSummary {
  title: string
  free?: number
  entries: FeedLine[]
}

export interface InboxQueue {
  headline: Headline
  first: QueueEntry | null
  /** «Después», ya filtrado; los números (`rank`) son los de la cola sin filtrar. */
  rest: QueueRow[]
  /** Filas de «Después» sin filtrar: el «K más». */
  restTotal: number
  /** `null` con 4 decisiones o menos. */
  filters: QueueFilter[] | null
  /** El filtro que se aplicó (uno que no tiene filas se ignora). */
  filter: QueueType | null
  pipeline: PipelineSummary
  running: RunningEntry[]
  queued: RunningEntry[]
  feed: FeedSummary | null
  hygiene: HygieneLine[]
  /** «Dónde se traba cada épica»: vacío si ninguna decisión trae épica. */
  epics: EpicLine[]
}

export interface QueueInput {
  /** En orden: el del dashboard o el que manda el runner. */
  items: readonly InboxItem[]
  capacity?: RunnerCapacity | null
  feed?: DashboardView['feed']
  hygiene?: readonly HygieneLine[]
  filter?: QueueType | null
  now: number
}

const isDecision = (item: InboxItem) => item.group === 'need' || item.group === 'fail'

const tasksIn = (row: QueueRow) => (row.kind === 'group' ? row.children.length : 1)

const failedIn = (row: QueueRow) =>
  row.kind === 'group'
    ? row.children.filter((c) => c.type === 'fail').length
    : row.type === 'fail'
      ? 1
      : 0

export function headlineOf(first: QueueEntry | null, rest: readonly QueueRow[]): Headline {
  const rows: QueueRow[] = first ? [first, ...rest] : [...rest]
  return {
    decisions: rows.length,
    tasks: rows.reduce((n, row) => n + tasksIn(row), 0),
    failed: rows.reduce((n, row) => n + failedIn(row), 0),
  }
}

export function filtersOf(
  rest: readonly QueueRow[],
  decisions: number,
  active: QueueType | null,
): QueueFilter[] | null {
  if (decisions <= FILTER_THRESHOLD) return null
  const types = TYPE_ORDER.map((type) => ({
    type,
    label: TYPE_META[type].label,
    count: rest.filter((row) => row.type === type).length,
    pressed: active === type,
  })).filter((f) => f.count > 0)
  return [{ type: null, label: 'Todas', count: rest.length, pressed: active === null }, ...types]
}

export function pipelineOf(
  items: readonly InboxItem[],
  capacity: RunnerCapacity | null | undefined,
): PipelineSummary {
  if (capacity)
    return {
      running: capacity.running,
      waiting: capacity.waiting,
      ...(capacity.free !== undefined ? { free: capacity.free } : {}),
      ...(capacity.max_concurrent !== undefined ? { max: capacity.max_concurrent } : {}),
      source: 'capacity',
    }
  return {
    running: items.filter((i) => i.group === 'run').length,
    waiting: items.filter((i) => i.group === 'queue').length,
    source: 'items',
  }
}

function liveOf(items: readonly InboxItem[], group: 'run' | 'queue', now: number): RunningEntry[] {
  return items
    .filter((item) => item.group === group)
    .map((item) => {
      const run = item.execution
      return {
        ref: item.ref,
        short: shortRef(item.ref),
        url: item.url,
        title: item.title,
        agent: run?.agent_id ?? run?.pipeline_id ?? '',
        age: ageOf(run?.started_at ?? item.since, now),
        ...(item.actions.includes('stop') ? { stop: actionOf('stop', item.action_defs) } : {}),
      }
    })
}

/** Lo que corre ahora (los items `run`). */
export function runningOf(items: readonly InboxItem[], now: number): RunningEntry[] {
  return liveOf(items, 'run', now)
}

/** Lo que espera su turno (los items `queue`): lo que lista la celda «en cola». */
export function queuedOf(items: readonly InboxItem[], now: number): RunningEntry[] {
  return liveOf(items, 'queue', now)
}

export function feedOf(
  feed: DashboardView['feed'] | undefined,
  capacity: RunnerCapacity | null | undefined,
): FeedSummary | null {
  if (!feed) return null
  return {
    title: feed.title,
    ...(capacity?.free !== undefined ? { free: capacity.free } : {}),
    entries: feed.entries.map((e) => ({
      ref: e.ref,
      short: shortRef(e.ref),
      url: e.url,
      title: e.title,
      ...(e.action ? { action: { ...e.action } } : {}),
    })),
  }
}

/** La cola entera. Tolera un runner viejo: sin capacity, feed ni hygiene. */
export function buildQueue(input: QueueInput): InboxQueue {
  const { items, now } = input
  const decisions = items.filter(isDecision)
  const [head, ...tail] = decisions
  const first = head ? entryOf(head, 1, now, FIRST_REASONS) : null
  const all = groupRows(
    tail.map((item) => entryOf(item, 0, now, ROW_REASONS)),
    2,
  )
  const headline = headlineOf(first, all)
  const filters = filtersOf(all, headline.decisions, input.filter ?? null)
  const filter =
    filters && input.filter && filters.some((f) => f.type === input.filter) ? input.filter : null
  return {
    headline,
    first,
    rest: filter ? all.filter((row) => row.type === filter) : all,
    restTotal: all.length,
    filters: filters?.map((f) => ({ ...f, pressed: f.type === filter })) ?? null,
    filter,
    pipeline: pipelineOf(items, input.capacity),
    running: runningOf(items, now),
    queued: queuedOf(items, now),
    feed: feedOf(input.feed, input.capacity),
    hygiene: [...(input.hygiene ?? [])],
    epics: epicsOf(decisions),
  }
}
