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
import type { ImprovementStore } from './ImprovementStore.js'
import {
  DEFAULT_TRACE_FIELDS,
  projectTraceEntry,
  type TracePageQuery,
  traceWindow,
} from './tracePage.js'

/** Lo que el asistente lee del runner. */
export interface AssistantBackend {
  inbox: Pick<InboxService, 'inbox' | 'item' | 'detail' | 'explain'>
  activity: Pick<ActivityPort, 'executions' | 'recentEvents' | 'trace' | 'eventsForTask'>
  config: () => ConfigSummary
  /** El estado del runner: providers, ejecuciones, webhooks. */
  status: () => Record<string, unknown>
  /** Donde esperan las mejoras que propone un agente de una pipeline. */
  improvements: Pick<ImprovementStore, 'add' | 'findOpen' | 'list' | 'get' | 'revise'>
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

  async listTasks() {
    this.activity('list_tasks', 'leyendo la bandeja')
    if (this.scope.kind === 'task') {
      return [brief(await this.task(this.scope.ref))]
    }
    return (await this.backend.inbox.inbox(this.projectId)).items.map(brief)
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
    return {
      ...detail,
      item: detail.item,
      trace: detail.trace
        .slice(from)
        .map((entry, i) => projectTraceEntry(entry, from + i, DEFAULT_TRACE_FIELDS)),
      trace_note: `Últimas ${detail.trace.length - from} de ${detail.trace.length} entradas de la última ejecución (o de la que muestra la bandeja), sin atributos. Para buscar, ver campos o el resto: assistant_get_trace.`,
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
    const owns = this.backend.activity.executions({ taskRef }).some((row) => row.id === id)
    if (!owns) throw new Error(`La ejecución ${id} no es de ${taskRef}`)
    this.activity('get_trace', `leyendo la traza de ${id}`)
    return traceWindow(id, this.backend.activity.trace(id), query)
  }

  config() {
    this.activity('get_config', 'leyendo la config')
    const config = this.backend.config()
    if (!this.projectId) return config
    return {
      ...config,
      pipelines: config.pipelines.filter(
        (pipeline) => pipeline.source_id === this.projectId || pipeline.source_id === 'runner',
      ),
    }
  }

  recentEvents(limit: unknown) {
    if (this.scope.kind === 'task') throw new Error('En el contexto de una tarea, usá get_task')
    this.activity('recent_events', 'leyendo los eventos recientes')
    const count = Math.min(Math.max(Number(limit) || 30, 1), 100)
    return this.backend.activity.recentEvents(count, this.projectId)
  }

  status() {
    if (this.scope.kind !== 'general') {
      throw new Error('El estado del runner se consulta en el contexto general')
    }
    this.activity('runner_status', 'leyendo el estado del runner')
    return this.backend.status()
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
    this.emit({
      type: 'proposal',
      proposal: {
        id: globalThis.crypto.randomUUID(),
        kind: 'issue',
        repo,
        title,
        body,
        ...(labels.length ? { labels } : {}),
        label: `Abrir un issue en ${repo}`,
        reason: String(input.reason ?? ''),
      },
    })
    return 'Propuesta mostrada. El issue NO está creado: la persona decide.'
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
      return `Ya hay una propuesta igual pendiente en la bandeja (${pending.id}, de ${pending.task_ref}): no la repito.`
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
      throw new Error(`Fuera de contexto: la mejora ${wanted} es de ${found.task_ref}`)
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
   * Una mejora nueva como card de la bandeja, que una persona abre o descarta como las demás. Con
   * `based_on`, hereda el destino, la tarea y la evidencia de una que ya existe; sin ella, sale de
   * una tarea del contexto (la de la conversación, o `task_ref`) y va a `repo`.
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
    this.activity('add_improvement', `guardando una mejora nueva en ${base.repo}`)
    const stored = this.backend.improvements.add({
      task_ref: base.task_ref,
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

  /** De dónde sale una mejora sin base: la tarea del contexto y el repo donde se abriría. */
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
    const wanted = input.task_ref ?? (this.scope.kind === 'task' ? this.scope.ref : undefined)
    if (!wanted) {
      throw new Error('Sin based_on, la mejora necesita task_ref: la tarea de la que sale')
    }
    return { task_ref: await this.taskRef(wanted), repo, target: input.target ?? 'engine' }
  }

  /** Las mejoras de la bandeja (de cualquier tarea): las pendientes, para no proponer otra igual,
   *  y las últimas que una persona abrió o descartó, para no insistir con lo rechazado y ver si
   *  el criterio de quien propone falla. */
  improvementHistory() {
    this.activity('list_improvements', 'leyendo las mejoras propuestas')
    const { improvements } = this.backend
    const brief = (proposal: ImprovementProposal) => ({
      id: proposal.id,
      task_ref: proposal.task_ref,
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
}
