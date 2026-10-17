/**
 * Un pedido al asistente, con su contexto adentro: en el de una tarea sólo ve esa tarea; en el de
 * un proyecto, sus tareas; en el general, todo el runner. Es lo que las actions del agente
 * (`actions/builtin/assistant.ts`) llaman: el contexto lo impone el runner, no el modelo. Lee
 * —bandeja, tarea, eventos, traza, config— y PROPONE acciones: ejecutarlas es de la persona.
 *
 * Con `origin`, la sesión es la de un agente que corre en la pipeline de una tarea (la
 * retrospectiva, al mergear su PR): nadie mira, así que un issue propuesto queda en la bandeja
 * (`ImprovementStore`) en vez de mostrarse.
 *
 * La tarea del contexto se lee aunque ya no esté en el board (su issue se cierra con el merge): la
 * retrospectiva la mira al mergearse, y una persona pregunta después por qué propuso lo que propuso.
 */
import type {
  AssistantScope,
  AssistantStreamEvent,
  ConfigSummary,
  ImprovementProposal,
  ImprovementTarget,
  InboxItem,
  TaskAction,
} from '@ia-flow/shared'
import type { ActivityPort } from '../inbox/ActivityPort.js'
import type { InboxService } from '../inbox/InboxService.js'
import { taskCost } from '../inbox/pricing.js'
import { BoardProposals } from './BoardProposals.js'
import type { ImprovementStore } from './ImprovementStore.js'
import { isLive, withLiveness } from './liveness.js'
import type { TraceInsight } from './TraceInsight.js'
import {
  DEFAULT_TRACE_FIELDS,
  projectTraceEntry,
  type TracePageQuery,
  traceWindow,
} from './tracePage.js'
import { type SearchTracesInput, searchTraces } from './traceSearch.js'

/** Lo que el asistente lee del runner. */
export interface AssistantBackend {
  inbox: Pick<InboxService, 'inbox' | 'item' | 'detail' | 'explain'>
  activity: Pick<ActivityPort, 'executions' | 'recentEvents' | 'trace' | 'eventsForTask'>
  /** Con `fullPromptOf`, el prompt de ese agente va completo (el resto, recortado). */
  config: (options?: { fullPromptOf?: string }) => ConfigSummary
  /** El estado del runner: providers, ejecuciones, webhooks. */
  status: () => Record<string, unknown>
  /** Donde esperan las mejoras que propone un agente de una pipeline. */
  improvements: Pick<ImprovementStore, 'add' | 'findOpen' | 'list' | 'get' | 'revise'>
  /** Búsqueda en las trazas de todas las ejecuciones y cada agente de una por separado; sin esto,
   *  no hay búsqueda ni último paso. */
  traces?: TraceInsight
  /** La hora del runner (para decir cuánto hace de algo); default, el reloj del sistema. */
  now?: () => Date
}

/** De dónde viene una sesión que no es un pedido de la web: el agente de una pipeline. */
export interface SessionOrigin {
  agent: string
  execution_id?: string
  /** El PR que la disparó. */
  pr_url?: string
}

/** Las acciones que trae el runner; un proyecto suma las suyas (`taskActions`) en `item.action_defs`. */
export const ACTION_LABELS: Record<string, string> = {
  merge: 'Mergear el PR',
  approve_prd: 'Aprobar el PRD y pasar a Build',
  back_to_refine: 'Devolver a Refine',
  answer_and_unblock: 'Comentar y quitar blocked',
  relaunch: 'Relanzar',
  retry: 'Reintentar',
  stop: 'Pedirle al agente que pare',
  rerun_review: 'Re-ejecutar el review',
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/

/** Lo que vuelve de una lectura, acotado. La traza no pasa por acá: se pagina (`tracePage.ts`). */
const MAX_RESULT_CHARS = 16_000

export function asToolResult(value: unknown, options: { capped?: boolean } = {}): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (options.capped === false) return text
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [recortado]` : text
}

/** Cuántas entradas del final de la traza trae `get_task`: un vistazo, sin payloads. */
const TASK_TRACE_TAIL = 40

/** Cuántas ejecuciones vivas trae `runner_status`. */
const LIVE_LIMIT = 30

/** Lo que trae `get_task` de una tarea que ya no está en el board. */
const CLOSED_EXECUTIONS = 20
const CLOSED_EVENTS = 50

/** Quién figura como autor de una mejora que el asistente agrega en una conversación. */
const IMPROVEMENT_AUTHOR = 'assistant'

/** Cuántas decididas trae `list_improvements`, de entre las últimas `DECIDED_SCAN` propuestas. */
const DECIDED_LIMIT = 30
const DECIDED_SCAN = 200

/** Un item sin lo que el modelo no necesita para razonar. */
function brief(item: InboxItem) {
  return {
    ref: item.ref,
    project: item.project_id,
    title: item.title,
    group: item.group,
    kind: item.kind,
    status: item.status,
    labels: item.labels,
    why: item.why,
    since: item.since,
    pr: item.pr?.number,
    blocked_by: item.blocked_by,
    unlocks: item.unlocks,
    epic: item.epic,
    priority: item.priority,
    reasons: item.reasons,
    agent_said: item.agent_said,
    actions: item.actions,
  }
}

export class AssistantSession {
  constructor(
    readonly scope: AssistantScope,
    private readonly backend: AssistantBackend,
    private readonly emit: (event: AssistantStreamEvent) => void,
    readonly origin?: SessionOrigin,
  ) {}

  private get projectId(): string | undefined {
    return this.scope.kind === 'project' ? this.scope.project_id : undefined
  }

  /** Una línea de actividad en la web ("· leyendo …"). */
  activity(name: string, summary: string): void {
    this.emit({ type: 'tool', name, summary })
  }

  /** Las tareas de una respuesta, como están en la bandeja: las de afuera del contexto o que no
   *  existen se descartan (no rompen la respuesta ya escrita). Sin repetir, en orden. */
  async resolveTasks(refs: readonly string[]): Promise<InboxItem[]> {
    const items: InboxItem[] = []
    for (const ref of new Set(refs)) {
      const item = await this.task(ref).catch(() => undefined)
      if (item) items.push(item)
    }
    return items
  }

  /** La tarea, si cae en el contexto; si no, un error que el modelo lee. */
  async task(ref: unknown): Promise<InboxItem> {
    const wanted = String(ref ?? '').trim()
    if (this.scope.kind === 'task' && wanted !== this.scope.ref) {
      throw new Error(`Fuera de contexto: esta conversación es sobre ${this.scope.ref}`)
    }
    const item = await this.backend.inbox.item(wanted)
    if (!item) throw new Error(`${wanted} no está en ningún board de este runner`)
    if (this.projectId && item.project_id !== this.projectId) {
      throw new Error(`Fuera de contexto: ${wanted} es del proyecto ${item.project_id}`)
    }
    return item
  }

  /** La hora del runner: con ella el modelo dice cuánto hace de algo. */
  private now(): Date {
    return this.backend.now?.() ?? new Date()
  }

  async listTasks() {
    this.activity('list_tasks', 'leyendo la bandeja')
    const items =
      this.scope.kind === 'task'
        ? [await this.task(this.scope.ref)]
        : (await this.backend.inbox.inbox(this.projectId)).items
    const now = this.now()
    return {
      now: now.toISOString(),
      tasks: items.map((item) => {
        const execution = item.execution
        if (!isLive(execution?.status) || !execution) return brief(item)
        const [live] = withLiveness([execution], this.backend.traces, now)
        const { id, pipeline_id, status, last_step_at, idle_seconds, agents } = live ?? execution
        const running = {
          execution_id: id,
          pipeline_id,
          status,
          last_step_at,
          idle_seconds,
          agents,
        }
        return { ...brief(item), running }
      }),
    }
  }

  /**
   * La ref de una tarea del contexto. En el de una tarea, la fija quien pregunta (o el runner, en
   * una pipeline) y puede no estar ya en el board (se cerró con el merge): basta con que sea esa.
   */
  private async taskRef(ref: unknown): Promise<string> {
    if (this.scope.kind !== 'task') return (await this.task(ref)).ref
    const wanted = String(ref ?? '').trim()
    if (wanted !== this.scope.ref) {
      throw new Error(`Fuera de contexto: esta conversación es sobre ${this.scope.ref}`)
    }
    return wanted
  }

  async taskDetail(ref: unknown) {
    const taskRef = await this.taskRef(ref)
    this.activity('get_task', `leyendo ${taskRef}`)
    const detail = (await this.backend.inbox.detail(taskRef)) ?? this.closedDetail(taskRef)
    if (!detail) throw new Error(`${taskRef} ya no está en la bandeja`)
    // La cola de la traza, sin payloads: el detalle (y el resto) se pide con assistant_get_trace.
    const from = Math.max(detail.trace.length - TASK_TRACE_TAIL, 0)
    const now = this.now()
    return {
      now: now.toISOString(),
      ...detail,
      item: detail.item,
      // Las vivas, con su último paso; la última y las vivas, con cada agente (un grupo paralelo
      // corre varios en la misma ejecución).
      executions: withLiveness(detail.executions, this.backend.traces, now, (_, i) => i === 0),
      trace: detail.trace
        .slice(from)
        .map((entry, i) => projectTraceEntry(entry, from + i, DEFAULT_TRACE_FIELDS)),
      trace_note: `Últimas ${detail.trace.length - from} de ${detail.trace.length} entradas de la última ejecución (o de la que muestra la bandeja), sin atributos; \`agent\` dice de qué agente es cada una (en un grupo paralelo se mezclan). Para buscar, ver campos o el resto: assistant_get_trace.`,
      ...taskCost(detail.executions),
    }
  }

  /** Lo que se sabe de la tarea del contexto fuera del board: sus ejecuciones, sus eventos y la
   *  traza de la última, sin la card. */
  private closedDetail(ref: string) {
    if (this.scope.kind !== 'task') return undefined
    const { activity } = this.backend
    const executions = activity.executions({ taskRef: ref, limit: CLOSED_EXECUTIONS })
    const last = executions.at(0)?.id
    return {
      item: { ref, note: 'La tarea ya no está en el board (su issue se cerró).' },
      executions,
      events: activity.eventsForTask(ref, CLOSED_EVENTS),
      trace: last ? activity.trace(last) : [],
    }
  }

  async explain(ref: unknown, eventType?: string) {
    const taskRef = await this.taskRef(ref)
    this.activity('explain_trigger', `evaluando reglas para ${taskRef}`)
    return (
      (await this.backend.inbox.explain(taskRef, eventType)) ??
      `${taskRef} no tiene eventos registrados todavía`
    )
  }

  async trace(ref: unknown, executionId: unknown, query: TracePageQuery = {}) {
    const taskRef = await this.taskRef(ref)
    const id = String(executionId ?? '')
    const owned = this.backend.activity.executions({ taskRef }).find((row) => row.id === id)
    if (!owned) throw new Error(`La ejecución ${id} no es de ${taskRef}`)
    this.activity('get_trace', `leyendo la traza de ${id}`)
    const now = this.now()
    const [live] = isLive(owned.status) ? withLiveness([owned], this.backend.traces, now) : []
    return {
      now: now.toISOString(),
      status: owned.status,
      ...(live?.last_step_at ? { last_step_at: live.last_step_at } : {}),
      ...(live?.idle_seconds !== undefined ? { idle_seconds: live.idle_seconds } : {}),
      ...(live?.agents ? { agents: live.agents } : {}),
      ...traceWindow(id, this.backend.activity.trace(id), query),
    }
  }

  /** Un texto en las trazas de todas las ejecuciones del contexto (en el de una tarea, las suyas). */
  searchTraces(input: SearchTracesInput) {
    this.activity('search_traces', `buscando "${input.text}" en las trazas`)
    const scope =
      this.scope.kind === 'task'
        ? { taskRef: this.scope.ref }
        : this.projectId
          ? { projectId: this.projectId }
          : {}
    return { now: this.now().toISOString(), ...searchTraces(this.backend.traces, input, scope) }
  }

  config(agentId?: string) {
    this.activity('get_config', 'leyendo la config')
    if (agentId) return this.agentConfig(agentId)
    const config = this.backend.config()
    if (!this.projectId) return config
    return {
      ...config,
      pipelines: config.pipelines.filter(
        (pipeline) => pipeline.source_id === this.projectId || pipeline.source_id === 'runner',
      ),
    }
  }

  /** Un agente de la config, con su prompt completo. */
  private agentConfig(agentId: string) {
    const agent = this.backend
      .config({ fullPromptOf: agentId })
      .agents.find((entry) => entry.id === agentId)
    if (!agent) throw new Error(`No hay un agente "${agentId}" en las pipelines de la config`)
    return agent
  }

  recentEvents(limit: unknown) {
    if (this.scope.kind === 'task') throw new Error('En el contexto de una tarea, usá get_task')
    this.activity('recent_events', 'leyendo los eventos recientes')
    const count = Math.min(Math.max(Number(limit) || 30, 1), 100)
    return this.backend.activity.recentEvents(count, this.projectId)
  }

  /** El estado del runner (leerlo es seguro en cualquier contexto) y las ejecuciones vivas del
   *  contexto, con su último paso y cada agente. */
  status() {
    this.activity('runner_status', 'leyendo el estado del runner')
    const now = this.now()
    const live = this.backend.activity
      .executions({ statuses: ['running', 'paused'], limit: LIVE_LIMIT })
      .filter((row) =>
        this.scope.kind === 'task'
          ? row.task_ref === this.scope.ref
          : !this.projectId || row.project_id === this.projectId,
      )
      .map(({ id, task_ref, pipeline_id, status, started_at }) => ({
        id,
        ...(task_ref ? { task_ref } : {}),
        pipeline_id,
        status,
        started_at,
      }))
    return {
      now: now.toISOString(),
      ...this.backend.status(),
      live_executions: withLiveness(live, this.backend.traces, now),
    }
  }

  /** Muestra la propuesta de abrir un issue en `repo` para que la persona la confirme con su
   *  login de GitHub —o, en la sesión de una pipeline, la deja en la bandeja—. No crea nada. */
  proposeIssue(input: {
    repo?: unknown
    title?: unknown
    body?: unknown
    labels?: unknown
    reason?: unknown
    /** Dónde se arregla (lo dice `propose_improvement`); sin esto, el runner (`engine`). */
    target?: ImprovementTarget
  }) {
    const repo = String(input.repo ?? '').trim()
    if (!REPO_RE.test(repo)) throw new Error(`El repo tiene que ser owner/repo, no "${repo}"`)
    const title = String(input.title ?? '').trim()
    const body = String(input.body ?? '').trim()
    if (!title || !body) throw new Error('El issue necesita título y cuerpo')
    const labels = Array.isArray(input.labels)
      ? input.labels.map((label) => String(label).trim()).filter(Boolean)
      : []
    const reason = String(input.reason ?? '')
    if (this.origin) return this.storeIssue({ repo, title, body, labels, reason }, input.target)
    this.emitIssue({ repo, title, body, labels, reason })
    return 'Propuesta mostrada. El issue NO está creado: la persona decide.'
  }

  /** La card de un issue propuesto, en el chat: la persona lo abre con su login o la ignora. */
  private emitIssue(issue: {
    repo: string
    title: string
    body: string
    labels: string[]
    reason: string
  }) {
    const { repo, labels } = issue
    this.emit({
      type: 'proposal',
      proposal: {
        id: globalThis.crypto.randomUUID(),
        kind: 'issue',
        repo,
        title: issue.title,
        body: issue.body,
        ...(labels.length ? { labels } : {}),
        label: `Abrir un issue en ${repo}`,
        reason: issue.reason,
      },
    })
  }

  /** La propuesta de una pipeline, a la bandeja: una igual pendiente en el mismo repo no se repite. */
  private storeIssue(
    issue: { repo: string; title: string; body: string; labels: string[]; reason: string },
    target: ImprovementTarget = 'engine',
  ) {
    const origin = this.origin as SessionOrigin
    if (this.scope.kind !== 'task') {
      throw new Error('Una propuesta fuera de una conversación tiene que ser de una tarea')
    }
    const pending = this.backend.improvements.findOpen(issue.repo, issue.title)
    if (pending) {
      const from = pending.task_ref ? `, de ${pending.task_ref}` : ''
      return `Ya hay una propuesta igual pendiente en la bandeja (${pending.id}${from}): no la repito.`
    }
    const { labels, ...rest } = issue
    const stored = this.backend.improvements.add({
      task_ref: this.scope.ref,
      ...(origin.pr_url ? { pr_url: origin.pr_url } : {}),
      agent: origin.agent,
      ...(origin.execution_id ? { execution_id: origin.execution_id } : {}),
      target,
      ...rest,
      ...(labels.length ? { labels } : {}),
    })
    return `Propuesta ${stored.id} guardada en la bandeja. El issue NO está creado: una persona decide.`
  }

  /** Una mejora del contexto (en el de una tarea, sólo las que salen de ella); con `open`, sólo
   *  si sigue pendiente: una que una persona ya abrió o descartó no se toca. */
  private improvement(id: unknown, open: boolean): ImprovementProposal {
    const wanted = String(id ?? '').trim()
    const found = this.backend.improvements.get(wanted)
    if (!found) throw new Error(`No existe la mejora ${wanted}`)
    if (this.scope.kind === 'task' && found.task_ref !== this.scope.ref) {
      const from = found.task_ref ? `es de ${found.task_ref}` : 'no sale de ninguna tarea'
      throw new Error(`Fuera de contexto: la mejora ${wanted} ${from}`)
    }
    if (open && found.status !== 'open') {
      const how = found.status === 'opened' ? 'ya se abrió como issue' : 'ya se descartó'
      throw new Error(`La mejora ${wanted} ${how}: no se ajusta`)
    }
    return found
  }

  /** Ajusta una mejora pendiente: la persona ve la card nueva en la bandeja, no el texto acá. */
  reviseImprovement(input: {
    id: string
    title?: string
    body?: string
    labels?: string[]
    reason?: string
  }): string {
    const { id, ...changes } = input
    const current = this.improvement(id, true)
    if (Object.values(changes).every((value) => value === undefined)) {
      throw new Error('No hay nada que ajustar: pasá title, body, labels o reason')
    }
    this.activity('revise_improvement', `ajustando la mejora ${current.id}`)
    if (!this.backend.improvements.revise(current.id, changes)) {
      throw new Error(`La mejora ${current.id} ya no está pendiente`)
    }
    return `Mejora ${current.id} ajustada: la card de la bandeja ya muestra la versión nueva. En tu respuesta no repitas el título ni el cuerpo; decí en dos o tres líneas qué cambiaste y por qué.`
  }

  /**
   * Una mejora nueva. Con `based_on`, hereda el destino, la tarea y la evidencia de una que ya
   * existe y queda como card de la bandeja, al lado de su base; sin ella, va a `repo` y sale de la
   * tarea del contexto (la de la conversación, o `task_ref`) o, en el chat general o de un
   * proyecto sin `task_ref`, de ninguna (una de config o del engine).
   *
   * En una conversación, la que pide la persona sin base no se guarda: sale como la card de un
   * issue propuesto en el chat, y si la confirma lo abre con su login. En la sesión de una
   * pipeline (nadie mira el chat), se guarda en la bandeja.
   */
  async addImprovement(input: {
    based_on?: string
    task_ref?: string
    repo?: string
    target?: ImprovementTarget
    title: string
    body: string
    labels?: string[]
    reason: string
  }): Promise<string> {
    const base = input.based_on
      ? this.improvement(input.based_on, false)
      : await this.improvementOrigin(input)
    const pending = this.backend.improvements.findOpen(base.repo, input.title)
    if (pending) {
      throw new Error(
        `Ya hay una mejora pendiente igual (${pending.id}): ajustala en vez de repetirla`,
      )
    }
    if (!this.origin && !input.based_on) {
      this.activity('add_improvement', `proponiendo una mejora en ${base.repo}`)
      this.emitIssue({ ...input, repo: base.repo, labels: input.labels ?? [] })
      return `Mejora propuesta como card en el chat (se abriría en ${base.repo}): NO quedó en la bandeja ni está creada, la persona la abre con el botón. En tu respuesta no repitas el título ni el cuerpo; decí en dos o tres líneas qué es.`
    }
    this.activity('add_improvement', `guardando una mejora nueva en ${base.repo}`)
    const stored = this.backend.improvements.add({
      ...(base.task_ref ? { task_ref: base.task_ref } : {}),
      ...(base.pr_url ? { pr_url: base.pr_url } : {}),
      agent: IMPROVEMENT_AUTHOR,
      ...(base.execution_id ? { execution_id: base.execution_id } : {}),
      target: base.target,
      repo: base.repo,
      title: input.title,
      body: input.body,
      ...(input.labels?.length ? { labels: input.labels } : {}),
      reason: input.reason,
    })
    const differs = base.id ? ` y en qué se diferencia de ${base.id}` : ''
    return `Mejora ${stored.id} guardada como card nueva en la bandeja (se abriría en ${base.repo}). En tu respuesta no repitas el título ni el cuerpo; decí en dos o tres líneas qué es${differs}.`
  }

  /** De dónde sale una mejora sin base: la tarea del contexto (si hay) y el repo donde se abriría.
   *  En el contexto de una tarea, es esa; fuera de él, la de `task_ref` o ninguna. */
  private async improvementOrigin(input: {
    task_ref?: string
    repo?: string
    target?: ImprovementTarget
  }): Promise<
    Pick<ImprovementProposal, 'task_ref' | 'repo' | 'target'> &
      Partial<Pick<ImprovementProposal, 'id' | 'pr_url' | 'execution_id'>>
  > {
    const repo = String(input.repo ?? '').trim()
    if (!REPO_RE.test(repo)) {
      throw new Error(`Sin based_on, la mejora necesita repo (owner/repo), no "${repo}"`)
    }
    const target = input.target ?? 'engine'
    const wanted = input.task_ref ?? (this.scope.kind === 'task' ? this.scope.ref : undefined)
    if (!wanted) return { repo, target }
    return { task_ref: await this.taskRef(wanted), repo, target }
  }

  /** Las mejoras de la bandeja (de cualquier tarea): las pendientes, para no proponer otra igual,
   *  y las últimas que una persona abrió o descartó, para no insistir con lo rechazado y ver si
   *  el criterio de quien propone falla. */
  improvementHistory() {
    this.activity('list_improvements', 'leyendo las mejoras propuestas')
    const { improvements } = this.backend
    const brief = (proposal: ImprovementProposal) => ({
      id: proposal.id,
      ...(proposal.task_ref ? { task_ref: proposal.task_ref } : {}),
      target: proposal.target,
      repo: proposal.repo,
      title: proposal.title,
      created_at: proposal.created_at,
    })
    return {
      pending: improvements.list('open').map(brief),
      decided: improvements
        .list(undefined, DECIDED_SCAN)
        .filter((proposal) => proposal.status !== 'open')
        .slice(0, DECIDED_LIMIT)
        .map((proposal) => ({
          ...brief(proposal),
          status: proposal.status,
          reason: proposal.reason,
          ...(proposal.issue_url ? { issue_url: proposal.issue_url } : {}),
          ...(proposal.decided_by ? { decided_by: proposal.decided_by } : {}),
          ...(proposal.decided_at ? { decided_at: proposal.decided_at } : {}),
        })),
    }
  }

  /** Muestra una propuesta para que la persona la confirme. No ejecuta nada. */
  async propose(input: { ref?: unknown; action?: unknown; reason?: unknown; comment?: unknown }) {
    if (this.origin) {
      throw new Error('Fuera de una conversación no se proponen acciones sobre una tarea')
    }
    const item = await this.task(input.ref)
    const action: TaskAction = String(input.action)
    // Sólo las que la tarea ofrece ahora: las del runner o las que declaró su proyecto.
    const def = item.action_defs?.find((candidate) => candidate.id === action)
    const label = def?.label ?? ACTION_LABELS[action]
    if (!label) throw new Error(`Acción desconocida: ${String(input.action)}`)
    if (!item.actions.includes(action)) {
      throw new Error(
        `${label} no aplica a ${item.ref} ahora (${item.why}). Aplica: ${item.actions.join(', ') || 'nada'}`,
      )
    }
    const comment = typeof input.comment === 'string' ? input.comment.trim() : ''
    const needsComment = def ? def.comment === 'required' : action === 'answer_and_unblock'
    if (needsComment && !comment) {
      throw new Error(`${action} necesita el comentario`)
    }
    this.emit({
      type: 'proposal',
      proposal: {
        id: globalThis.crypto.randomUUID(),
        ref: item.ref,
        action,
        label,
        reason: String(input.reason ?? ''),
        ...(comment ? { comment } : {}),
      },
    })
    return 'Propuesta mostrada. NO está ejecutada: la persona decide.'
  }

  /** Proponer mover una card, sumar un issue al board o cambiarle labels (`BoardProposals`). */
  get board(): BoardProposals {
    return new BoardProposals({
      scope: this.scope,
      unattended: this.origin !== undefined,
      task: (ref) => this.task(ref),
      inbox: this.backend.inbox,
      emit: (proposal) => this.emit({ type: 'proposal', proposal }),
    })
  }
}
