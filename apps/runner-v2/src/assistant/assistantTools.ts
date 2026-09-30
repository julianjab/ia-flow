/**
 * Las tools del asistente, armadas por pedido con su contexto adentro: en el de una tarea sólo ve
 * esa tarea; en el de un proyecto, sus tareas; en el general, todo el runner. El contexto lo impone
 * el runner (cada tool rechaza lo que queda afuera), no el modelo. Lee — bandeja, tarea, eventos,
 * traza, config — y PROPONE acciones: ejecutarlas es de la persona, con su login de GitHub.
 */
import type { Tool } from '@ia-flow/agent-engine'
import type {
  AssistantProposal,
  AssistantScope,
  ConfigSummary,
  InboxItem,
  TaskAction,
} from '@ia-flow/shared'
import type { ActivityPort } from '../inbox/ActivityPort.js'
import type { InboxService } from '../inbox/InboxService.js'

export interface AssistantDeps {
  inbox: Pick<InboxService, 'inbox' | 'item' | 'detail' | 'explain'>
  activity: Pick<ActivityPort, 'executions' | 'recentEvents' | 'trace'>
  config: () => ConfigSummary
  /** El estado del runner: providers, ejecuciones, webhooks. */
  status: () => Record<string, unknown>
}

export const ACTION_LABELS: Record<TaskAction, string> = {
  merge: 'Mergear el PR',
  approve_prd: 'Aprobar el PRD y pasar a Build',
  back_to_refine: 'Devolver a Refine',
  answer_and_unblock: 'Comentar y quitar blocked',
  relaunch: 'Relanzar',
  retry: 'Reintentar',
  stop: 'Pedirle al agente que pare',
}

/** Lo que vuelve de una tool, acotado: el modelo no necesita 200 KB de traza. */
const MAX_RESULT_CHARS = 16_000

function json(value: unknown): string {
  const text = JSON.stringify(value)
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… [recortado]` : text
}

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
    agent_said: item.agent_said,
    actions: item.actions,
  }
}

const refInput = {
  type: 'object',
  properties: {
    ref: { type: 'string', description: 'owner/repo#numero, p.ej. la-haus/subscriptions#420' },
  },
  required: ['ref'],
}

export function assistantTools(
  scope: AssistantScope,
  deps: AssistantDeps,
  propose: (proposal: AssistantProposal) => void,
  onActivity: (name: string, summary: string) => void,
): Tool[] {
  const projectId = scope.kind === 'project' ? scope.project_id : undefined

  /** La tarea, si cae en el contexto. */
  const scoped = async (ref: unknown): Promise<InboxItem> => {
    const wanted = String(ref ?? '').trim()
    if (scope.kind === 'task' && wanted !== scope.ref) {
      throw new Error(`Fuera de contexto: esta conversación es sobre ${scope.ref}`)
    }
    const item = await deps.inbox.item(wanted)
    if (!item) throw new Error(`${wanted} no está en ningún board de este runner`)
    if (projectId && item.project_id !== projectId) {
      throw new Error(`Fuera de contexto: ${wanted} es del proyecto ${item.project_id}`)
    }
    return item
  }

  const tools: Tool[] = [
    {
      name: 'list_tasks',
      description:
        'La bandeja del contexto: cada tarea con su grupo (need=te necesita, fail=falló, run=corriendo, queue=en cola), caso, por qué está ahí y qué acciones aplican.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        onActivity('list_tasks', 'leyendo la bandeja')
        if (scope.kind === 'task') return json([brief(await scoped(scope.ref))])
        return json((await deps.inbox.inbox(projectId)).items.map(brief))
      },
    },
    {
      name: 'get_task',
      description:
        'Una tarea: su estado en el board, sus ejecuciones (cómo terminó cada una, uso de tokens, por qué falló), los eventos que le llegaron con qué decidió cada pipeline, y la traza de la última ejecución.',
      inputSchema: refInput,
      handler: async (input: { ref?: string }) => {
        const item = await scoped(input.ref)
        onActivity('get_task', `leyendo ${item.ref}`)
        const detail = await deps.inbox.detail(item.ref)
        return json({
          ...detail,
          trace: detail?.trace.slice(-60).map((entry) => ({
            at: entry.start_time,
            kind: entry.kind,
            phase: entry.phase,
            name: entry.name,
            status: entry.status,
            level: entry.level,
            attributes: entry.attributes,
          })),
        })
      },
    },
    {
      name: 'explain_trigger',
      description:
        'Por qué corrió o NO corrió algo: evalúa, con el mismo criterio del engine, qué haría cada pipeline con el último evento de la tarea (o con uno de `event_type`) y qué condición cortó a las que no corren.',
      inputSchema: {
        type: 'object',
        properties: {
          ref: refInput.properties.ref,
          event_type: {
            type: 'string',
            description: 'Opcional: p.ej. issue.status_changed, issue.unblocked',
          },
        },
        required: ['ref'],
      },
      handler: async (input: { ref?: string; event_type?: string }) => {
        const item = await scoped(input.ref)
        onActivity('explain_trigger', `evaluando reglas para ${item.ref}`)
        const result = await deps.inbox.explain(item.ref, input.event_type)
        return result ? json(result) : `${item.ref} no tiene eventos registrados todavía`
      },
    },
    {
      name: 'get_trace',
      description:
        'La traza completa de una ejecución (spans y logs: tools, mensajes del modelo con tokens, hooks del CLI), en orden. El id sale de get_task.',
      inputSchema: {
        type: 'object',
        properties: { execution_id: { type: 'string' }, ref: refInput.properties.ref },
        required: ['execution_id', 'ref'],
      },
      handler: async (input: { execution_id?: string; ref?: string }) => {
        const item = await scoped(input.ref)
        const id = String(input.execution_id ?? '')
        const owns = deps.activity.executions({ taskRef: item.ref }).some((row) => row.id === id)
        if (!owns) throw new Error(`La ejecución ${id} no es de ${item.ref}`)
        onActivity('get_trace', `leyendo la traza de ${id}`)
        return json(deps.activity.trace(id, 300))
      },
    },
    {
      name: 'get_config',
      description:
        'La config cargada: qué eventos escucha cada pipeline, sus condiciones, qué agentes y acciones corre, y a dónde lleva cada salida de cada agente.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        onActivity('get_config', 'leyendo la config')
        const config = deps.config()
        if (!projectId) return json(config)
        return json({
          ...config,
          pipelines: config.pipelines.filter(
            (pipeline) => pipeline.source_id === projectId || pipeline.source_id === 'runner',
          ),
        })
      },
    },
    {
      name: 'propose_action',
      description: `Propone una acción sobre una tarea. NO la ejecuta: la persona la confirma con un botón. Acciones: ${Object.entries(
        ACTION_LABELS,
      )
        .map(([id, label]) => `${id} (${label})`)
        .join(
          ', ',
        )}. Sólo las que la tarea tiene en "actions". answer_and_unblock necesita comment.`,
      inputSchema: {
        type: 'object',
        properties: {
          ref: refInput.properties.ref,
          action: { type: 'string', enum: Object.keys(ACTION_LABELS) },
          reason: { type: 'string', description: 'Una frase: por qué conviene' },
          comment: { type: 'string', description: 'El comentario, para answer_and_unblock' },
        },
        required: ['ref', 'action', 'reason'],
      },
      handler: async (input: {
        ref?: string
        action?: string
        reason?: string
        comment?: string
      }) => {
        const item = await scoped(input.ref)
        const action = input.action as TaskAction
        if (!(action in ACTION_LABELS)) throw new Error(`Acción desconocida: ${input.action}`)
        if (!item.actions.includes(action)) {
          throw new Error(
            `${ACTION_LABELS[action]} no aplica a ${item.ref} ahora (${item.why}). Aplica: ${item.actions.join(', ') || 'nada'}`,
          )
        }
        if (action === 'answer_and_unblock' && !input.comment?.trim()) {
          throw new Error('answer_and_unblock necesita el comentario')
        }
        propose({
          id: globalThis.crypto.randomUUID(),
          ref: item.ref,
          action,
          label: ACTION_LABELS[action],
          reason: String(input.reason ?? ''),
          ...(input.comment?.trim() ? { comment: input.comment.trim() } : {}),
        })
        return 'Propuesta mostrada. NO está ejecutada: la persona decide.'
      },
    },
  ]

  if (scope.kind !== 'task') {
    tools.push({
      name: 'recent_events',
      description:
        'Lo último que llegó al runner (webhooks y eventos derivados) con qué decidió cada pipeline — para "qué pasó hoy", "por qué no reaccionó a X".',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
      handler: (input: { limit?: number }) => {
        onActivity('recent_events', 'leyendo los eventos recientes')
        const limit = Math.min(Math.max(Number(input.limit) || 30, 1), 100)
        return json(deps.activity.recentEvents(limit, projectId))
      },
    })
  }
  if (scope.kind === 'general') {
    tools.push({
      name: 'runner_status',
      description: 'El estado del runner: proyectos, providers, ejecuciones en curso y webhooks.',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        onActivity('runner_status', 'leyendo el estado del runner')
        return json(deps.status())
      },
    })
  }
  return tools
}
