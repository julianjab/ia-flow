/**
 * Un pedido al asistente, con su contexto adentro: en el de una tarea sólo ve esa tarea; en el de
 * un proyecto, sus tareas; en el general, todo el runner. Es lo que las actions del agente
 * (`actions/builtin/assistant.ts`) llaman: el contexto lo impone el runner, no el modelo. Lee
 * —bandeja, tarea, eventos, traza, config— y PROPONE acciones: ejecutarlas es de la persona.
 */
import type {
  AssistantScope,
  AssistantStreamEvent,
  ConfigSummary,
  InboxItem,
  TaskAction,
} from '@ia-flow/shared'
import type { ActivityPort } from '../inbox/ActivityPort.js'
import type { InboxService } from '../inbox/InboxService.js'
import {
  DEFAULT_TRACE_FIELDS,
  projectTraceEntry,
  type TracePageQuery,
  traceWindow,
} from './tracePage.js'

/** Lo que el asistente lee del runner. */
export interface AssistantBackend {
  inbox: Pick<InboxService, 'inbox' | 'item' | 'detail' | 'explain'>
  activity: Pick<ActivityPort, 'executions' | 'recentEvents' | 'trace'>
  config: () => ConfigSummary
  /** El estado del runner: providers, ejecuciones, webhooks. */
  status: () => Record<string, unknown>
  /** El label de cada proyecto (`project.yaml`), por id: marca que la card es de este runner. */
  projectLabels?: ReadonlyMap<string, string>
}

export const ACTION_LABELS: Record<TaskAction, string> = {
  merge: 'Mergear el PR',
  approve_prd: 'Aprobar el PRD y pasar a Build',
  back_to_refine: 'Devolver a Refine',
  answer_and_unblock: 'Comentar y quitar blocked',
  relaunch: 'Relanzar',
  retry: 'Reintentar',
  stop: 'Pedirle al agente que pare',
  rerun_review: 'Re-ejecutar el review',
}

/** Lo que vuelve de una lectura, acotado. La traza no pasa por acá: se pagina (`tracePage.ts`). */
const MAX_RESULT_CHARS = 16_000

export function asToolResult(value: unknown, options: { capped?: boolean } = {}): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (options.capped === false) return text
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [recortado]` : text
}

/** Cuántas entradas del final de la traza trae `get_task`: un vistazo, sin payloads. */
const TASK_TRACE_TAIL = 40

/** Un item sin lo que el modelo no necesita para razonar. */
function brief(item: InboxItem) {
  // `labels` ya viene sin el label del proyecto (`withoutOwnLabel`).
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
    agent_said: item.agent_said,
    actions: item.actions,
  }
}

export class AssistantSession {
  constructor(
    readonly scope: AssistantScope,
    private readonly backend: AssistantBackend,
    private readonly emit: (event: AssistantStreamEvent) => void,
  ) {}

  private get projectId(): string | undefined {
    return this.scope.kind === 'project' ? this.scope.project_id : undefined
  }

  /** Una línea de actividad en la web ("· leyendo …"). */
  activity(name: string, summary: string): void {
    this.emit({ type: 'tool', name, summary })
  }

  /** Sin el label del proyecto: marca de quién es la card (este runner o el otro engine), no un
   *  bloqueo — que el modelo lo vea sólo lo confunde. Un bloqueo real es `group`/`kind`/`blocked_by`. */
  private withoutOwnLabel(item: InboxItem): InboxItem {
    const own = this.backend.projectLabels?.get(item.project_id)
    return own ? { ...item, labels: item.labels.filter((label) => label !== own) } : item
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
      return [brief(this.withoutOwnLabel(await this.task(this.scope.ref)))]
    }
    return (await this.backend.inbox.inbox(this.projectId)).items
      .map((item) => this.withoutOwnLabel(item))
      .map(brief)
  }

  async taskDetail(ref: unknown) {
    const item = await this.task(ref)
    this.activity('get_task', `leyendo ${item.ref}`)
    const detail = await this.backend.inbox.detail(item.ref)
    if (!detail) return detail
    // La cola de la traza, sin payloads: el detalle (y el resto) se pide con assistant_get_trace.
    const from = Math.max(detail.trace.length - TASK_TRACE_TAIL, 0)
    return {
      ...detail,
      item: this.withoutOwnLabel(detail.item),
      trace: detail.trace
        .slice(from)
        .map((entry, i) => projectTraceEntry(entry, from + i, DEFAULT_TRACE_FIELDS)),
      trace_note: `Últimas ${detail.trace.length - from} de ${detail.trace.length} entradas de la última ejecución (o de la que muestra la bandeja), sin atributos. Para buscar, ver campos o el resto: assistant_get_trace.`,
    }
  }

  async explain(ref: unknown, eventType?: string) {
    const item = await this.task(ref)
    this.activity('explain_trigger', `evaluando reglas para ${item.ref}`)
    return (
      (await this.backend.inbox.explain(item.ref, eventType)) ??
      `${item.ref} no tiene eventos registrados todavía`
    )
  }

  async trace(ref: unknown, executionId: unknown, query: TracePageQuery = {}) {
    const item = await this.task(ref)
    const id = String(executionId ?? '')
    const owns = this.backend.activity
      .executions({ taskRef: item.ref })
      .some((row) => row.id === id)
    if (!owns) throw new Error(`La ejecución ${id} no es de ${item.ref}`)
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

  /** Muestra una propuesta para que la persona la confirme. No ejecuta nada. */
  async propose(input: { ref?: unknown; action?: unknown; reason?: unknown; comment?: unknown }) {
    const item = await this.task(input.ref)
    const action = String(input.action) as TaskAction
    if (!(action in ACTION_LABELS)) throw new Error(`Acción desconocida: ${String(input.action)}`)
    if (!item.actions.includes(action)) {
      throw new Error(
        `${ACTION_LABELS[action]} no aplica a ${item.ref} ahora (${item.why}). Aplica: ${item.actions.join(', ') || 'nada'}`,
      )
    }
    const comment = typeof input.comment === 'string' ? input.comment.trim() : ''
    if (action === 'answer_and_unblock' && !comment) {
      throw new Error('answer_and_unblock necesita el comentario')
    }
    this.emit({
      type: 'proposal',
      proposal: {
        id: globalThis.crypto.randomUUID(),
        ref: item.ref,
        action,
        label: ACTION_LABELS[action],
        reason: String(input.reason ?? ''),
        ...(comment ? { comment } : {}),
      },
    })
    return 'Propuesta mostrada. NO está ejecutada: la persona decide.'
  }
}
