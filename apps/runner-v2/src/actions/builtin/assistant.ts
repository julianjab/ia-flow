/**
 * Las tools del agente `assistant` (el asistente de la web): leer la bandeja, una tarea, por qué
 * corrió o no algo, la traza, la config, los eventos recientes y el estado del runner, y PROPONER
 * una acción, mover una card, sumar un issue al board, cambiar labels —o abrir un issue
 * (`assistant_propose_issue`, `propose_improvement`)— que la persona confirma. Ninguna escribe en GitHub: `sideEffects: 'none'`.
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
  TRACE_SEARCH_LIMIT,
  TRACE_SEARCH_MAX_LIMIT,
  TRACE_SEARCH_SAMPLES,
} from '../defineAction.js'

/** Los repos de cada destino que no son el de la tarea: los fija el YAML del agente (`options`). */
const ImprovementRepos = z.object({
  engine: z.string().optional(),
  config: z.string().optional(),
})

/** El repo de una mejora sin `repo`: el de su destino, si el runner lo declaró. */
function defaultRepo(
  repos: z.infer<typeof ImprovementRepos>,
  target: z.infer<typeof ImprovementTarget>,
): string | undefined {
  return target === 'docs' ? undefined : repos[target]
}

const ref = z.string().describe('owner/repo#numero, p.ej. la-haus/subscriptions#420')

/** `@ia-flow/shared` resuelve zod 3 y el runner zod 4: un schema de shared dentro de un input
 *  rompe `toJSONSchema` (no tiene `_zod`). Se rearma con el zod del runner, mismos valores. */
const ImprovementTarget = z.enum(ImprovementTargetSchema.options)

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

function tools(
  desk: AssistantDesk,
  agent: string | undefined,
  options: Record<string, unknown> = {},
): Action[] {
  const repos = ImprovementRepos.parse(options)
  return [
    new AssistantTool(
      'assistant_list_tasks',
      'La bandeja del contexto, en el orden a seguir: primero las decisiones (need=te necesita, fail=falló), cada una con `priority` (1 = lo primero que conviene hacer) y `reasons` (por qué va en ese lugar: cercanía a Done, cuántas tareas destraba —`unlocks`—, quién falló); después lo que corre (run) o espera turno (queue), sin `priority`. Cada tarea trae su caso, por qué está ahí y qué acciones aplican; una con ejecución viva trae `running`: cuándo fue su último paso (`last_step_at`), hace cuántos segundos (`idle_seconds`) y en qué está cada agente (`agents`). `now` es la hora del runner.',
      z.strictObject({}),
      desk,
      agent,
      (session) => session.listTasks(),
    ),
    new AssistantTool(
      'assistant_get_task',
      'Una tarea: su estado en el board, sus ejecuciones (cómo terminó cada una, tokens, costo ESTIMADO en USD, por qué falló), los eventos que le llegaron con qué decidió cada pipeline, y la traza de la última ejecución. Una ejecución viva trae `last_step_at` e `idle_seconds` (cuánto hace de su último paso); la viva y la última traen `agents` si corrió más de un agente (un grupo paralelo corre varios en la MISMA ejecución): el estado de cada uno (running, done, failed…), su último paso y su salida. `agent_id`/`exit`/`summary` de la ejecución son sólo del último que cerró. `now` es la hora del runner.',
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
      `Una página de la traza de una ejecución de la tarea (spans y logs: tools, mensajes del modelo con tokens, hooks del CLI), en orden. El id sale de assistant_get_task. Nada se corta: si hay más, \`next_offset\` dice desde dónde pedir la siguiente. Para "¿llamó a X?" usá \`contains\` en vez de leer todo. Sin \`fields\` trae ${DEFAULT_TRACE_FIELDS.join(', ')}; pedí \`attributes.<clave>\` (las claves vienen en \`attribute_keys\`, p.ej. \`attributes.ia.tool.input\`) o \`attributes\` para ver los payloads. Cada entrada dice su \`agent\`; con \`agent\` trae sólo las de ese (en un grupo paralelo se intercalan). Trae \`now\` y, si la ejecución sigue viva, \`last_step_at\`, \`idle_seconds\` y \`agents\`.`,
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
        agent: z
          .string()
          .optional()
          .describe('Sólo las entradas de este agente (p.ej. reviewer, e2e-visual-qa).'),
      }),
      desk,
      agent,
      (session, { ref: task, execution_id, ...query }) => session.trace(task, execution_id, query),
      false,
    ),
    new AssistantTool(
      'assistant_search_traces',
      `Busca un texto en las trazas de TODAS las ejecuciones guardadas (del contexto: en el de una tarea, sólo las suyas) — en el nombre, el mensaje de error y los atributos de cada entrada, sin distinguir mayúsculas. Para preguntas que cruzan tareas ("¿cuáles fueron los pause_turn?", "¿qué agentes escriben memoria?"), en vez de ir tarea por tarea. Devuelve, por ejecución (de la más nueva), su tarea, pipeline, estado, agentes, cuántas entradas coinciden y hasta ${TRACE_SEARCH_SAMPLES} de muestra (índice, nombre, extracto). Como mucho ${TRACE_SEARCH_MAX_LIMIT} ejecuciones: si \`truncated\`, acotá. El detalle, con assistant_get_trace.`,
      z.strictObject({
        text: z.string().min(2).describe('Lo que se busca, p.ej. pause_turn, memory, un error'),
        since: z.string().optional().describe('Sólo entradas desde (ISO)'),
        until: z.string().optional().describe('Sólo entradas hasta (ISO)'),
        agent_id: z.string().optional().describe('Sólo entradas de ese agente'),
        pipeline_id: z.string().optional(),
        status: z
          .enum(['running', 'paused', 'done', 'failed', 'superseded'])
          .optional()
          .describe('Sólo ejecuciones en ese estado'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(TRACE_SEARCH_MAX_LIMIT)
          .optional()
          .describe(`Máximo de ejecuciones (default ${TRACE_SEARCH_LIMIT})`),
      }),
      desk,
      agent,
      (session, input) => session.searchTraces(input),
    ),
    new AssistantTool(
      'assistant_get_config',
      'La config cargada: qué eventos escucha cada pipeline, sus condiciones, qué agentes y acciones corre, y a dónde lleva cada salida de cada agente. De cada agente: el modelo de cada provider (`models`), sus MCP (`mounted: false` = lo nombra y no quedó montado en este runner), sus tools/actions y su prompt (system prompts resueltos y plantilla del turno, recortados; `*_chars` es el largo completo). Con `agent_id`, sólo ese agente con el prompt completo.',
      z.strictObject({
        agent_id: z
          .string()
          .optional()
          .describe('Opcional: un agente; trae sólo ese, con su prompt completo.'),
      }),
      desk,
      agent,
      (session, input) => session.config(input.agent_id),
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
      'El estado del runner: la hora (`now`), proyectos, providers, ejecuciones en curso y webhooks, y las ejecuciones vivas del contexto (`live_executions`) con su último paso, hace cuántos segundos (`idle_seconds`) y cada agente. En cualquier contexto.',
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
    ...boardTools(desk, agent),
    new AssistantTool(
      'assistant_revise_improvement',
      'Ajusta una mejora propuesta que sigue pendiente (su título, cuerpo, labels o razón): la card de la bandeja pasa a mostrar la versión nueva y la persona la abre o la descarta como siempre. Usala cuando te pidan corregir o ajustar una mejora: NO pegues el issue en tu respuesta. Sólo cambia lo que pases.',
      z.strictObject({
        id: z.string().describe('El id de la mejora'),
        title: z.string().optional().describe('Corto, en imperativo: qué hay que cambiar'),
        body: z
          .string()
          .optional()
          .describe(
            'Markdown completo: ## Problema, ## Evidencia, ## Propuesta, ## Cómo verificarlo',
          ),
        labels: z.array(z.string()).optional(),
        reason: z.string().optional().describe('Una frase: por qué conviene'),
      }),
      desk,
      agent,
      (session, input) => session.reviseImprovement(input),
    ),
    new AssistantTool(
      'assistant_add_improvement',
      'Guarda una mejora como card nueva en la bandeja: una persona la abre como issue o la descarta. Con `based_on` (el id de una mejora existente) hereda su destino, su tarea y su evidencia: para proponer OTRA cosa que esa (otro problema, o la mitad que conviene separar). Sin mejoras en la bandeja, o sin relación con una, pasá `repo` (owner/repo donde se abriría), `target` y, si sale de una tarea, `task_ref` (en el contexto de una tarea, es esa). Una mejora de config o del engine que no nace de una tarea (en el chat general o de un proyecto) se guarda sin `task_ref`. Si es la misma mejora corregida, usá assistant_revise_improvement.',
      z.strictObject({
        based_on: z
          .string()
          .optional()
          .describe('El id de la mejora de la que sale (fija el repo y la tarea)'),
        task_ref: ref
          .optional()
          .describe(
            'Sin based_on: la tarea de la que sale, si sale de una (en el contexto de una tarea, esa)',
          ),
        repo: z
          .string()
          .optional()
          .describe(
            `Sin based_on: owner/repo donde se abriría el issue${repos.engine ? `. Sin repo, una de engine va a ${repos.engine}` : ''}${repos.config ? ` y una de config a ${repos.config}` : ''}`,
          ),
        target: ImprovementTarget.optional().describe(
          'Sin based_on: dónde se arregla — docs (la documentación de un repo), config (agentes, prompts, pipelines) o engine (el runner). Default engine',
        ),
        title: z.string().describe('Corto, en imperativo: qué hay que cambiar'),
        body: z
          .string()
          .describe(
            'Markdown completo: ## Problema, ## Evidencia, ## Propuesta, ## Cómo verificarlo',
          ),
        labels: z.array(z.string()).optional(),
        reason: z.string().describe('Una frase: por qué conviene'),
      }),
      desk,
      agent,
      (session, input) =>
        session.addImprovement(
          input.based_on || input.repo
            ? input
            : { ...input, repo: defaultRepo(repos, input.target ?? 'engine') },
        ),
    ),
  ]
}

/** Proponer cambios al board —mover, sumar, labels—: como las acciones, la persona confirma. */
function boardTools(desk: AssistantDesk, agent: string | undefined): Action[] {
  const reason = z.string().describe('Una frase: por qué conviene')
  return [
    new AssistantTool(
      'assistant_propose_move',
      'Propone mover la card de una tarea a otra columna del board (como moverla en GitHub: arranca el pipeline de esa columna). NO la mueve: la persona confirma con un botón, firmado con su usuario de GitHub. Sólo a una columna del board de la tarea, y no con un agente trabajando en ella (proponé antes stop).',
      z.strictObject({
        ref,
        status: z.string().min(1).describe('La columna destino, tal como se llama en el board'),
        reason,
      }),
      desk,
      agent,
      (session, input) => session.board.move(input),
    ),
    new AssistantTool(
      'assistant_propose_add_to_board',
      'Propone sumar al board un issue abierto que todavía no está. NO lo suma: la persona confirma con un botón, firmado con su usuario de GitHub. Si ya está en el board, proponé moverlo.',
      z.strictObject({
        issue: z.string().describe('owner/repo#numero o el link del issue'),
        status: z
          .string()
          .optional()
          .describe('La columna donde entra; sin esto, la de entrada del runner (Todo)'),
        project_id: z
          .string()
          .optional()
          .describe(
            'El proyecto del runner, si tiene más de uno (en el contexto de un proyecto, ese)',
          ),
        reason,
      }),
      desk,
      agent,
      (session, input) => session.board.addToBoard(input),
    ),
    new AssistantTool(
      'assistant_draft_issue',
      'Propone abrir un issue NUEVO a partir de lo que la persona te contó (un texto, una idea, un bug) y sumarlo al board para refinarlo: la base de la tarea, no el PRD. NO lo crea: la persona lo confirma con un botón (puede cambiar la columna) y queda abierto con su usuario de GitHub. Sólo en un repo del catálogo del proyecto (`repos` en assistant_runner_status); si no está claro cuál, preguntá antes. No en el contexto de una tarea.',
      z.strictObject({
        repo: z.string().describe('owner/repo del catálogo del proyecto donde se abre'),
        title: z.string().describe('Corto y concreto: qué hay que hacer o qué falla'),
        body: z
          .string()
          .describe(
            'Markdown con lo que contó la persona, ordenado: ## Contexto, ## Qué se necesita (o ## Qué pasa, si es un bug), ## Lo que se sabe, ## Preguntas abiertas. Sin inventar requisitos ni el PRD: eso lo hace el refiner',
          ),
        labels: z.array(z.string()).optional().describe('Labels que ya existen en el repo'),
        status: z
          .string()
          .optional()
          .describe(
            'La columna donde entra: sin esto, Todo (espera); Refine si la persona quiere que el refiner arranque ya',
          ),
        project_id: z
          .string()
          .optional()
          .describe('El proyecto, si el runner tiene más de uno (en el de un proyecto, ese)'),
        reason,
      }),
      desk,
      agent,
      (session, input) => session.board.draftIssue(input),
    ),
    new AssistantTool(
      'assistant_propose_labels',
      'Propone poner o sacar labels del issue de una tarea —p.ej. sacar `blocked`, que frena a los agentes—. NO los cambia: la persona confirma con un botón, firmado con su usuario de GitHub. Sólo labels que la tarea tiene (para sacar) o no tiene (para poner).',
      z.strictObject({
        ref,
        add: z.array(z.string()).optional().describe('Labels a poner'),
        remove: z.array(z.string()).optional().describe('Labels a sacar'),
        reason,
      }),
      desk,
      agent,
      (session, input) => session.board.labels(input),
    ),
  ]
}

/** Abrir un issue, aparte de las otras: sólo la tiene el agente de un deploy que la lista (y el
 *  repo lo fija su YAML con `with: { repo }`, así el modelo no elige dónde). */
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

/**
 * Proponer una mejora por DÓNDE se arregla, no por repo: `docs` va al repo de la tarea, `config`
 * y `engine` a los de `options: { config, engine }`. Así el modelo no elige dónde abrir, y un destino
 * que el deploy no declaró se rechaza. Con `list_improvements`, para no repetir lo pendiente ni lo
 * que una persona ya descartó.
 */
function proposeImprovement(
  desk: AssistantDesk,
  agent: string | undefined,
  options: Record<string, unknown>,
): Action[] {
  const repos = ImprovementRepos.parse(options)
  const repoOf = (session: AssistantSession, target: z.infer<typeof ImprovementTarget>) => {
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
        target: ImprovementTarget.describe('Dónde se arregla'),
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
      'Las mejoras ya propuestas (de cualquier tarea): `pending`, las que esperan en la bandeja, y `decided`, las últimas que una persona abrió como issue (`opened`) o descartó (`dismissed`), con quién y cuándo. Antes de proponer, mirá que no esté pendiente ni descartada.',
      z.strictObject({}),
      desk,
      agent,
      (session) => session.improvementHistory(),
    ),
  ]
}

export default [
  defineAction({
    id: 'assistant',
    create: (ctx) => tools(ctx.services.assistant, ctx.agentId, ctx.options),
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
