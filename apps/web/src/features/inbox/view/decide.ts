// De los hechos de las tareas (`GET /api/tasks`) y un dashboard a lo que se ve: la decisión de cada
// tarea, ordenada. Puro: la misma entrada da la misma salida, sin red ni Vue.

import { Condition, type ConditionRow, renderText } from '@ia-flow/rules'
import type { InboxGroup, InboxItem, RunnerCapacity, TaskFact, Tasks } from '@ia-flow/shared'
import type { Dashboard, DashboardRow, Decision } from '@/features/inbox/view/dashboard'

const GROUP_ORDER: Record<Exclude<InboxGroup, 'idle'>, number> = {
  need: 0,
  fail: 1,
  run: 2,
  queue: 3,
}

function excerpt(text: string | undefined, max = 160): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function tokens(task: TaskFact): string {
  const usage = task.live_run?.usage
  if (!usage) return ''
  const total = usage.input_tokens + usage.output_tokens + usage.cache_read_tokens
  return total > 0 ? ` · ${Math.round(total / 1000)}k tokens` : ''
}

/** Los textos ya armados que una plantilla puede pedir (`fmt.*`): lo que en otro caso sería
 *  lógica repetida en cada dashboard. */
function fmtOf(task: TaskFact) {
  const live = task.live_run
  return {
    pr: task.pr ? ` · PR #${task.pr.number}` : ' · sin PR abierto',
    tokens: tokens(task),
    who: live ? (live.agent_id ? `${live.pipeline_id} → ${live.agent_id}` : live.pipeline_id) : '',
    pause: live?.pause?.pause_id ?? 'pausa',
    expires: live?.pause?.expires_at ? ` · vence ${live.pause.expires_at}` : '',
    summary: excerpt(task.run.summary),
    blocked_by: task.blocked_by_refs.join(', '),
  }
}

/** La raíz sobre la que se evalúa un `when` y se resuelve una plantilla. */
export function rootOf(task: TaskFact): Record<string, unknown> {
  return { ...task, fmt: fmtOf(task) }
}

const toConditions = (rows: DashboardRow[] | undefined) =>
  (rows ?? []).map((row) => new Condition(row as ConditionRow))

const holds = (rows: DashboardRow[] | undefined, root: Record<string, unknown>) =>
  Condition.evaluateAll(toConditions(rows), root)

const text = (template: string, root: Record<string, unknown>) => renderText(template, root).trim()

/** El primer texto de la lista que no queda vacío. */
function firstOf(templates: string[], root: Record<string, unknown>): string | undefined {
  for (const template of templates) {
    const value = text(template, root)
    if (value) return value
  }
  return undefined
}

/** Lo que la tarea trae tal cual, sin pasar por el dashboard: PR, corrida, bloqueos, épica. */
function factsOf(
  task: TaskFact,
): Pick<InboxItem, 'pr' | 'execution' | 'blocked_by' | 'unlocks' | 'epic'> {
  const execution = task.live_run ?? task.last_run
  return {
    ...(task.pr ? { pr: task.pr } : {}),
    ...(execution ? { execution } : {}),
    ...(task.blocked_by_refs.length > 0 ? { blocked_by: task.blocked_by_refs } : {}),
    ...(task.task.unlocks > 0 ? { unlocks: task.task.unlocks } : {}),
    ...(task.epic ? { epic: { ...task.epic } } : {}),
  }
}

function itemOf(task: TaskFact, decision: Decision): InboxItem {
  const root = rootOf(task)
  const offered = task.actions
  const shown = decision.actions ? decision.actions.filter((id) => offered.includes(id)) : offered
  const since = firstOf([decision.since].flat(), root) ?? task.updated_at
  const said = decision.said ? text(decision.said, root) : ''
  const context = decision.context ? text(decision.context, root) : ''
  const chips = decision.chips
    .filter((chip) => holds(chip.when, root))
    .map((chip) => ({ text: text(chip.text, root), ...(chip.tone ? { tone: chip.tone } : {}) }))
    .filter((chip) => chip.text)
  const defs = task.action_defs.filter((def) => shown.includes(def.id))
  return {
    ref: task.ref,
    project_id: task.project_id,
    title: task.title,
    url: task.url,
    group: decision.group,
    kind: decision.kind,
    ...(task.item.status ? { status: task.item.status } : {}),
    labels: task.item.labels,
    why: text(decision.why, root),
    since,
    ...factsOf(task),
    ...(said ? { agent_said: said } : {}),
    actions: shown,
    ...(defs.length > 0 ? { action_defs: defs } : {}),
    ...(decision.verb ? { verb: text(decision.verb, root) } : {}),
    ...(decision.primary && shown.includes(decision.primary) ? { primary: decision.primary } : {}),
    ...(context ? { context } : {}),
    ...(chips.length > 0 ? { chips } : {}),
  }
}

/** La decisión de una tarea: la primera del dashboard cuyo `when` se cumple. */
export function decisionFor(task: TaskFact, dashboard: Dashboard): Decision | undefined {
  const root = rootOf(task)
  return dashboard.decisions.find((candidate) => holds(candidate.when, root))
}

/** Cómo se ve una tarea según el dashboard; `undefined` si no es una decisión. */
export function decide(task: TaskFact, dashboard: Dashboard): InboxItem | undefined {
  const decision = decisionFor(task, dashboard)
  return decision ? itemOf(task, decision) : undefined
}

/** Cómo se desempata: cada criterio en el orden del dashboard, hasta que alguno decide. */
export function ranked(
  items: Array<{ item: InboxItem; weight: number }>,
  rank: Dashboard['rank'],
): InboxItem[] {
  const compare = (
    a: { item: InboxItem; weight: number },
    b: { item: InboxItem; weight: number },
  ): number => {
    for (const criterion of rank) {
      const diff =
        criterion === 'group'
          ? GROUP_ORDER[a.item.group as keyof typeof GROUP_ORDER] -
            GROUP_ORDER[b.item.group as keyof typeof GROUP_ORDER]
          : criterion === 'weight'
            ? b.weight - a.weight
            : criterion === 'unlocks'
              ? (b.item.unlocks ?? 0) - (a.item.unlocks ?? 0)
              : a.item.since.localeCompare(b.item.since)
      if (diff !== 0) return diff
    }
    return 0
  }
  return [...items].sort(compare).map(({ item }) => item)
}

export interface FeedEntry {
  ref: string
  title: string
  url: string
  /** La acción del runner que la pone a correr, si la ofrece para esta tarea. */
  action?: { id: string; label: string }
}

export interface HygieneLine {
  text: string
  count: number
}

export interface DashboardView {
  items: InboxItem[]
  feed: { title: string; entries: FeedEntry[] } | null
  hygiene: HygieneLine[]
  capacity: RunnerCapacity | null
}

function hygieneLine(template: string, count: number): HygieneLine {
  return { text: renderText(template, { count }), count }
}

export function buildView(tasks: Tasks, dashboard: Dashboard): DashboardView {
  const decided = tasks.tasks.flatMap((task) => {
    const decision = decisionFor(task, dashboard)
    return decision ? [{ item: itemOf(task, decision), weight: decision.weight }] : []
  })

  const { feed } = dashboard.panels
  const entries: FeedEntry[] = feed
    ? tasks.tasks
        .filter((task) => holds(feed.when, rootOf(task)))
        .slice(0, feed.limit)
        .map((task) => {
          const def = feed.action ? task.action_defs.find((d) => d.id === feed.action) : undefined
          return {
            ref: task.ref,
            title: task.title,
            url: task.url,
            ...(def ? { action: { id: def.id, label: def.label } } : {}),
          }
        })
    : []

  const hygiene = dashboard.panels.hygiene.map((line) => ({
    ...hygieneLine(line.text, tasks.tasks.filter((task) => holds(line.when, rootOf(task))).length),
  }))

  return {
    items: ranked(decided, dashboard.rank),
    feed: feed ? { title: feed.title, entries } : null,
    hygiene,
    capacity: dashboard.panels.pipeline ? tasks.capacity : null,
  }
}
