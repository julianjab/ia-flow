/**
 * Las tools del agente `assistant` (el asistente de la web): leer la bandeja, una tarea, por qué
 * corrió o no algo, la traza, la config, los eventos recientes y el estado del runner, y PROPONER
 * una acción —o abrir un issue (`assistant_propose_issue`, `propose_improvement`)— que la persona
 * confirma. Ninguna escribe en GitHub: `sideEffects: 'none'`.
 *
 * Cada una atiende el pedido que la está usando (`AssistantDesk`, por el `session` del payload de
 * la capacidad), y es ese pedido el que impone el contexto: en el de una tarea, otra ref se
 * rechaza. En la pipeline de una tarea (la retrospectiva) el contexto es esa tarea, y un issue
 * propuesto queda en la bandeja. Fuera de los dos, fallan diciendo por qué.
 */
import { Action, type PipelineExecutionContext, type ToolInputSchema } from '@ia-flow/agent-engine'
import { ImprovementTargetSchema } from '@ia-flow/shared'
import { z } from 'zod'
import {
  ACTION_LABELS,
  type AssistantDesk,
  type AssistantSession,
  asToolResult,
  DEFAULT_TRACE_FIELDS,
  defineAction,
  TRACE_FIELDS,
  TRACE_PAGE_LIMIT,
  TRACE_PAGE_MAX_LIMIT,
} from '../defineAction.js'

const ref = z.string().describe('owner/repo#numero, p.ej. la-haus/subscriptions#420')

/** Una tool del asistente: su input y qué le pide a la sesión del pedido. */
class AssistantTool<S extends ToolInputSchema> extends Action<S, string> {
  override readonly sideEffects = 'none' as const

  constructor(
    id: string,
    readonly description: string,
    readonly input: S,
    private readonly desk: AssistantDesk,
    /** El agente que la tiene: firma lo que propone en una pipeline. */
    private readonly agent: string | undefined,
    private readonly read: (session: AssistantSession, input: z.infer<S>) => unknown,
    /** `false` para una lectura que ya se acota sola (paginada): cortarla perdería lo que sigue. */
    private readonly capped = true,
  ) {
    super({ id })
  }

  async execute(input: z.infer<S>, ctx: PipelineExecutionContext): Promise<string> {
    const value = await this.read(this.desk.sessionFor(ctx, this.agent), input)
    return asToolResult(value, { capped: this.capped })
  }
}

function tools(desk: AssistantDesk, agent: string | undefined): Action[] {
  return [
    new AssistantTool(
      'assistant_list_tasks',
      'La bandeja del contexto: cada tarea con su grupo (need=te necesita, fail=falló, run=corriendo, queue=en cola), caso, por qué está ahí y qué acciones aplican.',
      z.strictObject({}),
      desk,
      agent,
      (session) => session.listTasks(),
    ),
    new AssistantTool(
      'assistant_get_task',
      'Una tarea: su estado en el board, sus ejecuciones (cómo terminó cada una, tokens, por qué falló), los eventos que le llegaron con qué decidió cada pipeline, y la traza de la última ejecución.',
      z.strictObject({ ref }),
      desk,
      agent,
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
      agent,
      (session, input) => session.explain(input.ref, input.event_type),
    ),
    new AssistantTool(
      'assistant_get_trace',
      `Una página de la traza de una ejecución de la tarea (spans y logs: tools, mensajes del modelo con tokens, hooks del CLI), en orden. El id sale de assistant_get_task. Nada se corta: si hay más, \`next_offset\` dice desde dónde pedir la siguiente. Para "¿llamó a X?" usá \`contains\` en vez de leer todo. Sin \`fields\` trae ${DEFAULT_TRACE_FIELDS.join(', ')}; pedí \`attributes.<clave>\` (las claves vienen en \`attribute_keys\`, p.ej. \`attributes.ia.tool.input\`) o \`attributes\` para ver los payloads.`,
      z.strictObject({
        ref,
        execution_id: z.string(),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Desde qué entrada (de las que pasan `contains`). Default 0; el `next_offset` de la página anterior.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TRACE_PAGE_MAX_LIMIT)
          .optional()
          .describe(
            `Máximo de entradas por página (default ${TRACE_PAGE_LIMIT}); la página corta antes si se llena.`,
          ),
        fields: z
          .array(z.string())
          .optional()
          .describe(
            `Campos de cada entrada: ${TRACE_FIELDS.join(', ')}, \`attributes\` (todos) o \`attributes.<clave>\` (uno). \`index\` viene siempre.`,
          ),
        contains: z
          .string()
          .optional()
          .describe(
            'Sólo las entradas cuyo nombre o atributos contienen este texto (sin distinguir mayúsculas), p.ej. el nombre de una tool.',
          ),
      }),
      desk,
      agent,
      (session, { ref: task, execution_id, ...query }) => session.trace(task, execution_id, query),
      false,
    ),
    new AssistantTool(
      'assistant_get_config',
      'La config cargada: qué eventos escucha cada pipeline, sus condiciones, qué agentes y acciones corre, y a dónde lleva cada salida de cada agente.',
      z.strictObject({}),
      desk,
      agent,
      (session) => session.config(),
    ),
    new AssistantTool(
      'assistant_recent_events',
      'Lo último que llegó al runner (webhooks y eventos derivados) con qué decidió cada pipeline — para "qué pasó hoy" o "por qué no reaccionó a X". No en el contexto de una tarea.',
      z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
      desk,
      agent,
      (session, input) => session.recentEvents(input.limit),
    ),
    new AssistantTool(
      'assistant_runner_status',
      'El estado del runner: proyectos, providers, ejecuciones en curso y webhooks. Sólo en el contexto general.',
      z.strictObject({}),
      desk,
      agent,
      (session) => session.status(),
    ),
    new AssistantTool(
      'assistant_propose_action',
      `Propone una acción sobre una tarea. NO la ejecuta: la persona la confirma con un botón y queda firmada con su usuario de GitHub. Sólo las que la tarea tiene en "actions" (las del proyecto traen su nombre en "action_defs"). Acciones del runner: ${Object.entries(
        ACTION_LABELS,
      )
        .map(([id, label]) => `${id} (${label})`)
        .join(', ')}.`,
      z.strictObject({
        ref,
        action: z.string().min(1),
        reason: z.string().describe('Una frase: por qué conviene'),
        comment: z
          .string()
          .optional()
          .describe('El comentario, para las acciones que lo piden (answer_and_unblock)'),
      }),
      desk,
      agent,
      (session, input) => session.propose(input),
    ),
  ]
}

/** Abrir un issue, aparte de las otras: sólo la tiene el agente que la lista (y el repo lo fija
 *  su YAML con `with: { repo }`, así el modelo no elige dónde). */
function proposeIssue(desk: AssistantDesk, agent: string | undefined): Action {
  return new AssistantTool(
    'assistant_propose_issue',
    'Propone abrir un issue en GitHub. NO lo crea: la persona lo confirma con un botón y queda abierto con su usuario de GitHub. Antes, buscá si ya hay uno igual.',
    z.strictObject({
      repo: z.string().describe('owner/repo donde se abre'),
      title: z.string().describe('Corto, en imperativo: qué hay que cambiar'),
      body: z
        .string()
        .describe('Markdown: el problema, la evidencia (tarea, ejecución, traza) y la mejora'),
      labels: z.array(z.string()).optional().describe('Labels que ya existen en el repo'),
      reason: z.string().describe('Una frase: por qué conviene abrirlo'),
    }),
    desk,
    agent,
    (session, input) => session.proposeIssue(input),
  )
}

/** Los repos de cada destino que no son el de la tarea: los fija el YAML del agente (`options`). */
const ImprovementRepos = z.object({
  engine: z.string().optional(),
  config: z.string().optional(),
})

/**
 * Proponer una mejora por DÓNDE se arregla, no por repo: `docs` va al repo de la tarea, `config`
 * y `engine` a los de `options: { config, engine }`. Así el modelo no elige dónde abrir, y un destino
 * que el deploy no declaró se rechaza. Con `list_improvements`, para no repetir lo pendiente.
 */
function proposeImprovement(
  desk: AssistantDesk,
  agent: string | undefined,
  options: Record<string, unknown>,
): Action[] {
  const repos = ImprovementRepos.parse(options)
  const repoOf = (session: AssistantSession, target: z.infer<typeof ImprovementTargetSchema>) => {
    if (target === 'docs') {
      if (session.scope.kind !== 'task') throw new Error('docs es el repo de una tarea')
      return session.scope.ref.split('#')[0] as string
    }
    const repo = repos[target]
    if (!repo)
      throw new Error(`Este runner no declaró el repo de \`${target}\`: proponé otro destino`)
    return repo
  }
  return [
    new AssistantTool(
      'propose_improvement',
      `Propone abrir un issue con una mejora, según DÓNDE se arregla: docs (la documentación del repo de la tarea: AGENTS.md, CLAUDE.md, README)${repos.config ? `, config (la config del runner: agentes, prompts, pipelines — ${repos.config})` : ''}${repos.engine ? `, engine (el runner o el engine — ${repos.engine})` : ''}. NO lo crea: queda pendiente y una persona lo abre con su usuario de GitHub. Una mejora por llamada.`,
      z.strictObject({
        target: ImprovementTargetSchema.describe('Dónde se arregla'),
        title: z.string().describe('Corto, en imperativo: qué hay que cambiar'),
        body: z
          .string()
          .describe('Markdown: ## Problema, ## Evidencia, ## Propuesta, ## Cómo verificarlo'),
        labels: z.array(z.string()).optional().describe('Labels que ya existen en el repo'),
        reason: z.string().describe('Una frase: por qué conviene'),
      }),
      desk,
      agent,
      (session, { target, ...input }) =>
        session.proposeIssue({ ...input, repo: repoOf(session, target), target }),
    ),
    new AssistantTool(
      'list_improvements',
      'Las mejoras ya propuestas que siguen pendientes en la bandeja (de cualquier tarea): antes de proponer, mirá que no esté.',
      z.strictObject({}),
      desk,
      agent,
      (session) => session.pendingImprovements(),
    ),
  ]
}

export default [
  defineAction({
    id: 'assistant',
    create: (ctx) => tools(ctx.services.assistant, ctx.agentId),
  }),
  defineAction({
    id: 'assistant_propose_issue',
    create: (ctx) => proposeIssue(ctx.services.assistant, ctx.agentId),
  }),
  defineAction({
    id: 'propose_improvement',
    create: (ctx) => proposeImprovement(ctx.services.assistant, ctx.agentId, ctx.options),
  }),
]
