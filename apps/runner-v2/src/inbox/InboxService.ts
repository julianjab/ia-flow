/**
 * La bandeja: las cards de cada board cruzadas con lo que el runner sabe de su task (la ejecución
 * viva, la última cerrada, si espera turno, el último evento), clasificadas por `classify`. También
 * el detalle de una tarea (sus ejecuciones, eventos y traza) y el "¿por qué corrió / no corrió?".
 */
import type { ExecutionSummary, ExplainResult, Inbox, InboxItem, TaskDetail } from '@ia-flow/shared'
import { type ActivityPort, type ExplainPort, taskOfKey } from './ActivityPort.js'
import type { BoardSpec } from './BoardReader.js'
import {
  type BoardCard,
  type Classification,
  classify,
  inboxOrder,
  type TaskActivity,
} from './classify.js'
import type { InboxSettings } from './InboxSection.js'

export interface InboxServiceOptions {
  projects: BoardSpec[]
  board: { cards(spec: BoardSpec): Promise<BoardCard[]> }
  activity: ActivityPort
  /** Las claves de ejecución con una corrida esperando turno (`ExecutionStore.waitingKeys`). */
  waitingKeys: () => string[]
  explain: ExplainPort
  settings: InboxSettings
  now?: () => Date
}

const TRACE_LIMIT = 200
const EVENTS_LIMIT = 30

export class InboxService {
  constructor(private readonly options: InboxServiceOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }

  private specs(projectId?: string): BoardSpec[] {
    return this.options.projects.filter((spec) => !projectId || spec.projectId === projectId)
  }

  private async cards(projectId?: string): Promise<BoardCard[]> {
    const boards = await Promise.all(
      this.specs(projectId).map((spec) => this.options.board.cards(spec)),
    )
    return boards.flat()
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

  private toItem(card: BoardCard, activity: TaskActivity, found: Classification): InboxItem {
    const execution = activity.live ?? activity.lastClosed
    const failure = activity.lastClosed?.failure
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
      ...((found.group === 'need' || found.group === 'fail') && failure
        ? { agent_said: failure.message }
        : {}),
      actions: found.actions,
    }
  }

  private classifyOptions(spec: BoardSpec | undefined) {
    return {
      settings: this.options.settings,
      ...(spec?.label ? { projectLabel: spec.label } : {}),
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
      const spec = this.options.projects.find((entry) => entry.projectId === card.projectId)
      const found = classify(card, activity, this.classifyOptions(spec))
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
      projects: this.specs(projectId).map((spec) => ({ id: spec.projectId, board: spec.board })),
      items: items.sort(inboxOrder),
    }
  }

  /** La tarea, clasificada aunque no esté en la bandeja (`idle`). */
  async item(ref: string): Promise<InboxItem | undefined> {
    const card = await this.card(ref)
    if (!card) return undefined
    const activity = this.activityOf(ref, this.liveByTask(), this.waitingTasks())
    const spec = this.options.projects.find((entry) => entry.projectId === card.projectId)
    const found = classify(card, activity, this.classifyOptions(spec)) ?? {
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
