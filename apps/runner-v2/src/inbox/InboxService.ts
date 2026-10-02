/**
 * La bandeja: las cards de cada board cruzadas con lo que el runner sabe de su task (la ejecución
 * viva, la última cerrada, si espera turno, el último evento), clasificadas por `classify`. También
 * el detalle de una tarea (sus ejecuciones, eventos y traza), el "¿por qué corrió / no corrió?" y
 * el resto del board (lo que la bandeja no muestra).
 */
import type {
  BoardRest,
  BoardRestItem,
  ExecutionSummary,
  ExplainResult,
  Inbox,
  InboxItem,
  InboxProject,
  TaskDetail,
} from '@ia-flow/shared'
import { type ActivityPort, type ExplainPort, taskOfKey } from './ActivityPort.js'
import { type BoardMeta, type BoardSpec, cardItem, inProject, projectUrl } from './BoardReader.js'
import {
  type BoardCard,
  type Classification,
  classify,
  inboxOrder,
  type TaskActivity,
} from './classify.js'
import type { InboxSettings } from './InboxSection.js'
import type { TaskActionDefs } from './TaskActionDef.js'
import { availableTaskActions, runFacts, type TaskFacts } from './TaskActionRunner.js'

export interface InboxServiceOptions {
  projects: BoardSpec[]
  board: {
    /** Todas las cards abiertas del board. */
    cards(spec: BoardSpec): Promise<BoardCard[]>
    /** Los links y columnas del Project. Sin esto, el link del Project sin la vista de tablero. */
    meta?(spec: BoardSpec): Promise<BoardMeta>
  }
  activity: ActivityPort
  /** Las claves de ejecución con una corrida esperando turno (`ExecutionStore.waitingKeys`). */
  waitingKeys: () => string[]
  explain: ExplainPort
  settings: InboxSettings
  /** Las `taskActions` de cada proyecto (`project.yaml`): las que declara mandan sobre las que
   *  trae `classify`. Sin esto, sólo las del runner. */
  taskActions?: (projectId: string) => TaskActionDefs
  now?: () => Date
}

const TRACE_LIMIT = 200
const EVENTS_LIMIT = 30

/** Lo último que dijo el agente: el motivo de su fallo, o —en una salida que no falla, como una
 *  duda o una pieza que falta— lo que resumió al cerrar. */
function agentSaid(found: Classification, activity: TaskActivity): string | undefined {
  const closed = activity.lastClosed
  if (found.group === 'need' || found.group === 'fail') {
    if (closed?.failure) return closed.failure.message
    if (found.kind === 'doubt' || found.kind === 'prerequisite') return closed?.summary
  }
  return undefined
}

export class InboxService {
  constructor(private readonly options: InboxServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private specs(projectId?: string): BoardSpec[] {
    return this.options.projects.filter((spec) => !projectId || spec.projectId === projectId)
  }

  /** Las cards del proyecto: las de su board que cumplen su `when` (`project.yaml`). */
  private async boardCards(projectId?: string): Promise<BoardCard[]> {
    const boards = await Promise.all(
      this.specs(projectId).map(async (spec) =>
        (await this.options.board.cards(spec)).filter((card) => inProject(spec, card)),
      ),
    )
    return boards.flat()
  }

  /** Las cards del board del proyecto —todas—: las que clasifica la bandeja, mueven las acciones y
   *  lee el asistente. */
  private async cards(projectId?: string): Promise<BoardCard[]> {
    return this.boardCards(projectId)
  }

  private async projects(projectId?: string): Promise<InboxProject[]> {
    return Promise.all(
      this.specs(projectId).map(async (spec) => {
        const meta = await this.options.board.meta?.(spec)
        const url = meta?.url ?? projectUrl(spec.board)
        return { id: spec.projectId, board: spec.board, url, board_url: meta?.boardUrl ?? url }
      }),
    )
  }

  /** Lo que la bandeja no muestra —las cards sin pendientes—, por columna
   *  en el orden del board; una columna que el board no declara, al final. */
  async rest(projectId?: string): Promise<BoardRest> {
    const cards = await this.boardCards(projectId)
    const shown = new Set((await this.inbox(projectId)).items.map((item) => item.ref))
    const order: string[] = []
    for (const spec of this.specs(projectId)) {
      for (const status of (await this.options.board.meta?.(spec))?.statuses ?? []) {
        if (!order.includes(status)) order.push(status)
      }
    }
    const columns = new Map<string, BoardRestItem[]>()
    for (const card of cards) {
      if (shown.has(card.ref)) continue
      const status = card.status ?? 'Sin status'
      const items = columns.get(status) ?? []
      items.push({
        ref: card.ref,
        project_id: card.projectId,
        title: card.title,
        url: card.url,
        ...(card.status ? { status: card.status } : {}),
        labels: card.labels,
        updated_at: card.updatedAt,
        ...(card.pr ? { pr: card.pr } : {}),
      })
      columns.set(status, items)
    }
    const rank = (status: string) => {
      const at = order.indexOf(status)
      return at === -1 ? order.length : at
    }
    return {
      columns: [...columns.entries()]
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
        .map(([status, items]) => ({
          status,
          items: items.sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
        })),
    }
  }

  /** La card de una tarea, en el board que la tenga. */
  async card(ref: string): Promise<BoardCard | undefined> {
    return (await this.cards()).find((card) => card.ref === ref)
  }

  private activityOf(
    ref: string,
    live: Map<string, ExecutionSummary>,
    waiting: Set<string>,
  ): TaskActivity {
    const { activity } = this.options
    const lastClosed = activity
      .executions({ taskRef: ref, statuses: ['done', 'failed', 'superseded'], limit: 1 })
      .at(0)
    const lastEventAt = activity.lastEventAt(ref)
    const running = live.get(ref)
    return {
      waiting: waiting.has(ref),
      ...(running ? { live: running } : {}),
      ...(lastClosed ? { lastClosed } : {}),
      ...(lastEventAt ? { lastEventAt } : {}),
    }
  }

  private liveByTask(): Map<string, ExecutionSummary> {
    const live = new Map<string, ExecutionSummary>()
    for (const execution of this.options.activity.executions({ statuses: ['running', 'paused'] })) {
      if (execution.task_ref && !live.has(execution.task_ref))
        live.set(execution.task_ref, execution)
    }
    return live
  }

  private waitingTasks(): Set<string> {
    const refs = this.options.waitingKeys().map((key) => taskOfKey(key).taskRef)
    return new Set(refs.filter((ref): ref is string => ref !== undefined))
  }

  /** Los hechos de una tarea que miran las guardas de sus `taskActions`. */
  private factsOf(card: BoardCard, activity: TaskActivity): TaskFacts {
    return { item: cardItem(card), run: runFacts(activity.lastClosed) }
  }

  /** Lo que se ofrece: las acciones que declaró el proyecto mandan —su `available` decide— y las
   *  del runner (`classify`) siguen para las que no declaró. */
  private offered(card: BoardCard, activity: TaskActivity, found: Classification) {
    const defs = this.options.taskActions?.(card.projectId) ?? {}
    const declared = availableTaskActions(defs, this.factsOf(card, activity))
    return {
      actions: [...found.actions.filter((id) => !(id in defs)), ...declared],
      defs: declared.map((id) => {
        const def = defs[id] as NonNullable<(typeof defs)[string]>
        return {
          id,
          label: def.label,
          ...(def.input?.comment ? { comment: def.input.comment } : {}),
          ...(def.confirm ? { confirm: def.confirm } : {}),
        }
      }),
    }
  }

  private toItem(card: BoardCard, activity: TaskActivity, found: Classification): InboxItem {
    const execution = activity.live ?? activity.lastClosed
    const offered = this.offered(card, activity, found)
    return {
      ref: card.ref,
      project_id: card.projectId,
      title: card.title,
      url: card.url,
      group: found.group,
      kind: found.kind,
      ...(card.status ? { status: card.status } : {}),
      labels: card.labels,
      ...(card.taskType ? { task_type: card.taskType } : {}),
      why: found.why,
      since: found.since,
      ...(card.pr ? { pr: card.pr } : {}),
      ...(execution ? { execution } : {}),
      ...(card.blockedBy.length > 0 ? { blocked_by: card.blockedBy } : {}),
      ...(agentSaid(found, activity) ? { agent_said: agentSaid(found, activity) } : {}),
      actions: offered.actions,
      ...(offered.defs.length > 0 ? { action_defs: offered.defs } : {}),
    }
  }

  private classifyOptions() {
    return {
      settings: this.options.settings,
      now: this.now(),
    }
  }

  async inbox(projectId?: string): Promise<Inbox> {
    const cards = await this.cards(projectId)
    const live = this.liveByTask()
    const waiting = this.waitingTasks()
    const items: InboxItem[] = []
    for (const card of cards) {
      const activity = this.activityOf(card.ref, live, waiting)
      const found = classify(card, activity, this.classifyOptions())
      if (found) items.push(this.toItem(card, activity, found))
    }
    const unlocks = new Map<string, number>()
    for (const card of cards) {
      for (const blocker of card.blockedBy) unlocks.set(blocker, (unlocks.get(blocker) ?? 0) + 1)
    }
    for (const item of items) {
      const count = unlocks.get(item.ref)
      if (count) item.unlocks = count
    }
    return {
      generated_at: this.now().toISOString(),
      projects: await this.projects(projectId),
      items: items.sort(inboxOrder),
    }
  }

  /** Lo que miran las guardas y los pasos de una acción sobre esta tarea. */
  async taskFacts(ref: string): Promise<TaskFacts | undefined> {
    const card = await this.card(ref)
    if (!card) return undefined
    return this.factsOf(card, this.activityOf(ref, this.liveByTask(), this.waitingTasks()))
  }

  /** La tarea, clasificada aunque no esté en la bandeja (`idle`). */
  async item(ref: string): Promise<InboxItem | undefined> {
    const card = await this.card(ref)
    if (!card) return undefined
    const activity = this.activityOf(ref, this.liveByTask(), this.waitingTasks())
    const found = classify(card, activity, this.classifyOptions()) ?? {
      group: 'idle',
      kind: 'idle',
      why: `No necesita nada ahora${card.status ? ` (status ${card.status})` : ''}`,
      since: card.updatedAt,
      actions: [],
    }
    return this.toItem(card, activity, found)
  }

  async detail(ref: string, executionId?: string): Promise<TaskDetail | undefined> {
    const item = await this.item(ref)
    if (!item) return undefined
    const { activity } = this.options
    const executions = activity.executions({ taskRef: ref, limit: 20 })
    const traced = executionId ?? executions.at(0)?.id
    return {
      item,
      executions,
      events: activity.eventsForTask(ref, EVENTS_LIMIT),
      trace: traced ? activity.trace(traced, TRACE_LIMIT) : [],
    }
  }

  /** Qué haría cada pipeline con el último evento de la tarea, o con uno de `eventType` armado
   *  sobre el payload de ese último (la card tal cual está). */
  async explain(ref: string, eventType?: string): Promise<ExplainResult | undefined> {
    const last = this.options.activity.lastDispatchedEvent(ref)
    if (!last) return undefined
    const synthetic = eventType !== undefined && eventType !== last.type
    const event = synthetic ? { ...last, id: `explain-${last.id}`, type: eventType } : last
    const decisions = await this.options.explain(event)
    const summary = this.options.activity
      .eventsForTask(ref, EVENTS_LIMIT)
      .find((entry) => entry.id === last.id)?.summary
    return {
      ref,
      event: { type: event.type, summary: summary ?? {} },
      source: synthetic ? 'synthetic' : 'last_event',
      decisions,
    }
  }
}
