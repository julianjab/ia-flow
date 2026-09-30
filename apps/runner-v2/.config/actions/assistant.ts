/**
 * Las tools del agente `assistant` (el asistente de la web): leer la bandeja, una tarea, por qué
 * corrió o no algo, la traza, la config, los eventos recientes y el estado del runner, y PROPONER
 * una acción que la persona confirma. Ninguna escribe: `sideEffects: 'none'`.
 *
 * Cada una atiende el pedido que la está usando (`AssistantDesk`, por el `session` del payload de
 * la capacidad), y es ese pedido el que impone el contexto: en el de una tarea, otra ref se
 * rechaza. Fuera de un pedido al asistente, fallan diciendo por qué.
 */
import { Action, type PipelineExecutionContext, type ToolInputSchema } from '@ia-flow/agent-engine'
import {
  ACTION_LABELS,
  type AssistantDesk,
  type AssistantSession,
  asToolResult,
  defineAction,
} from '@ia-flow/runner-v2/actions'
import { z } from 'zod'

const ref = z.string().describe('owner/repo#numero, p.ej. la-haus/subscriptions#420')

/** Una tool del asistente: su input y qué le pide a la sesión del pedido. */
class AssistantTool<S extends ToolInputSchema> extends Action<S, string> {
  override readonly sideEffects = 'none' as const

  constructor(
    id: string,
    readonly description: string,
    readonly input: S,
    private readonly desk: AssistantDesk,
    private readonly read: (session: AssistantSession, input: z.infer<S>) => unknown,
  ) {
    super({ id })
  }

  async execute(input: z.infer<S>, ctx: PipelineExecutionContext): Promise<string> {
    return asToolResult(await this.read(this.desk.sessionOf(ctx.event.payload), input))
  }
}

function tools(desk: AssistantDesk): Action[] {
  return [
    new AssistantTool(
      'assistant_list_tasks',
      'La bandeja del contexto: cada tarea con su grupo (need=te necesita, fail=falló, run=corriendo, queue=en cola), caso, por qué está ahí y qué acciones aplican.',
      z.strictObject({}),
      desk,
      (session) => session.listTasks(),
    ),
    new AssistantTool(
      'assistant_get_task',
      'Una tarea: su estado en el board, sus ejecuciones (cómo terminó cada una, tokens, por qué falló), los eventos que le llegaron con qué decidió cada pipeline, y la traza de la última ejecución.',
      z.strictObject({ ref }),
      desk,
      (session, input) => session.taskDetail(input.ref),
    ),
    new AssistantTool(
      'assistant_explain_trigger',
      'Por qué corrió o NO corrió algo: evalúa, con el mismo criterio del engine, qué haría cada pipeline con el último evento de la tarea (o con uno de `event_type`) y qué condición cortó a las que no corren.',
      z.strictObject({
        ref,
        event_type: z
          .string()
          .optional()
          .describe('Opcional: p.ej. issue.status_changed, issue.unblocked'),
      }),
      desk,
      (session, input) => session.explain(input.ref, input.event_type),
    ),
    new AssistantTool(
      'assistant_get_trace',
      'La traza completa de una ejecución de la tarea (spans y logs: tools, mensajes del modelo con tokens, hooks del CLI), en orden. El id sale de assistant_get_task.',
      z.strictObject({ ref, execution_id: z.string() }),
      desk,
      (session, input) => session.trace(input.ref, input.execution_id),
    ),
    new AssistantTool(
      'assistant_get_config',
      'La config cargada: qué eventos escucha cada pipeline, sus condiciones, qué agentes y acciones corre, y a dónde lleva cada salida de cada agente.',
      z.strictObject({}),
      desk,
      (session) => session.config(),
    ),
    new AssistantTool(
      'assistant_recent_events',
      'Lo último que llegó al runner (webhooks y eventos derivados) con qué decidió cada pipeline — para "qué pasó hoy" o "por qué no reaccionó a X". No en el contexto de una tarea.',
      z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
      desk,
      (session, input) => session.recentEvents(input.limit),
    ),
    new AssistantTool(
      'assistant_runner_status',
      'El estado del runner: proyectos, providers, ejecuciones en curso y webhooks. Sólo en el contexto general.',
      z.strictObject({}),
      desk,
      (session) => session.status(),
    ),
    new AssistantTool(
      'assistant_propose_action',
      `Propone una acción sobre una tarea. NO la ejecuta: la persona la confirma con un botón y queda firmada con su usuario de GitHub. Sólo las que la tarea tiene en "actions". Acciones: ${Object.entries(
        ACTION_LABELS,
      )
        .map(([id, label]) => `${id} (${label})`)
        .join(', ')}.`,
      z.strictObject({
        ref,
        action: z.enum(Object.keys(ACTION_LABELS) as [string, ...string[]]),
        reason: z.string().describe('Una frase: por qué conviene'),
        comment: z.string().optional().describe('El comentario, para answer_and_unblock'),
      }),
      desk,
      (session, input) => session.propose(input),
    ),
  ]
}

export default defineAction({
  id: 'assistant',
  create: (ctx) => tools(ctx.services.assistant),
})
