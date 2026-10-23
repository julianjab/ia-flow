/**
 * El contrato de la bandeja de runner-v2 con la web: qué te necesita, qué falló, qué corre y qué
 * espera — más lo que el asistente y la vista de una tarea leen (ejecuciones, eventos y su traza).
 * La web valida cada respuesta con `.parse()`; el runner arma estos objetos con los tipos inferidos.
 */
import { z } from 'zod'

/** Los cuatro grupos de la bandeja, en orden de urgencia — más `idle`, que nunca está en la
 *  bandeja: es el de una tarea que se pide por su ref (el detalle, el asistente) y no necesita nada. */
export const InboxGroupSchema = z.enum(['need', 'fail', 'run', 'queue', 'idle'])
export type InboxGroup = z.infer<typeof InboxGroupSchema>

/**
 * El caso dentro de su grupo:
 * - need: `merge` (Review + reviewed), `prd` (Refined), `prerequisite` (blocked: al agente le falta
 *   una pieza), `doubt` (blocked por una salida de error
 *   del agente), `stale` (Refine/Build sin ejecución ni cambios hace rato)
 * - fail: `crash` (la corrida falló por el runner o el provider)
 * - run: `agent` (ejecución corriendo), `ci` (pausada esperando el CI)
 * - queue: `turn` (encolada detrás de otra), `dep` (bloqueada por otro issue)
 * - idle: `idle` (fuera de la bandeja)
 */
export const InboxKindSchema = z.enum([
  'merge',
  /** En Review sin `reviewed`: el reviewer no la aprobó (o no corrió). */
  'review',
  'prd',
  'doubt',
  /** blocked porque le falta una pieza (un issue que todavía no existe o no cerró): no es una
   *  decisión de producto. */
  'prerequisite',
  'stale',
  'crash',
  'agent',
  'ci',
  'turn',
  'dep',
  'idle',
])
export type InboxKind = z.infer<typeof InboxKindSchema>

/** Las acciones que trae el runner. Un proyecto declara las suyas en `taskActions` (`project.yaml`)
 *  con otros ids: por eso lo que viaja por el wire es un string. */
export const BuiltinTaskActionSchema = z.enum([
  'merge',
  'approve_prd',
  'back_to_refine',
  'answer_and_unblock',
  'relaunch',
  'retry',
  'stop',
  /** Vuelve a correr el reviewer, como si la card acabara de llegar a Review. */
  'rerun_review',
  /** Vuelve a correr el pipeline de la columna en la que está la card (Refine o Build), como si
   *  acabara de llegar ahí. */
  'rerun_stage',
  /** Comenta en el issue a nombre de la persona: lo lee el pipeline de comentarios, como uno
   *  escrito en GitHub. Se ofrece siempre, también con un agente trabajando. */
  'comment',
  /** Cierra un PR de la tarea sin mergearlo (p. ej. un duplicado), con un comentario opcional en
   *  el PR. Sin `pr`, el de la card. */
  'close_pr',
])
export type BuiltinTaskAction = z.infer<typeof BuiltinTaskActionSchema>

/** El id de una acción de la bandeja: una de las del runner o una declarada por el proyecto (el
 *  mismo formato que las claves de `taskActions`). Que la tarea la ofrezca ahora lo decide el
 *  runner: pedirle una que no ofrece es un 409. */
export const TaskActionSchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'id de acción inválido')
export type TaskAction = z.infer<typeof TaskActionSchema>

/** Una acción declarada por el proyecto (`taskActions`) tal como la ofrece a una tarea. */
export const TaskActionDefSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** Pide un comentario a la persona. */
  comment: z.enum(['required', 'optional']).optional(),
  /** La pregunta de confirmación; sin ella, la web usa una genérica. */
  confirm: z.string().optional(),
})
export type TaskActionDef = z.infer<typeof TaskActionDefSchema>

export const ExecutionUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
})
export type ExecutionUsage = z.infer<typeof ExecutionUsageSchema>

/**
 * Cuánto costó una ejecución, ESTIMADO: sus tokens por los precios de `pricing:` (runner.yaml,
 * USD por millón). No es una factura: no ve descuentos, batch ni el precio de otra plataforma.
 */
export const ExecutionCostSchema = z.object({
  /** USD de los tokens que se cobran por token (un provider de API). Ausente si alguno de sus
   *  modelos no tiene precio: un número a medias engaña más que ninguno. */
  usd: z.number().optional(),
  /** Hubo tokens de un provider de suscripción (`claude-cli`, `claude-tmux`): no se cobran por
   *  token, así que no suman a `usd`. */
  subscription: z.boolean().optional(),
  /** Los modelos cobrados por token que no tienen precio en `pricing:`. */
  unpriced_models: z.array(z.string()).optional(),
})
export type ExecutionCost = z.infer<typeof ExecutionCostSchema>

/**
 * Un agente dentro de una ejecución. Los de un grupo paralelo (`reviewer` + `e2e-visual-qa`) corren
 * en LA MISMA ejecución: `agent_id`/`exit` de la ejecución son sólo del último que cerró.
 */
export const ExecutionAgentSchema = z.object({
  agent_id: z.string(),
  /** `running` sigue; `unfinished`: la ejecución terminó sin que cerrara (se cortó). */
  state: z.enum(['running', 'waiting', 'done', 'failed', 'interrupted', 'unfinished']),
  started_at: z.string(),
  ended_at: z.string().optional(),
  /** Lo último que dejó en la traza (una tool, un request al modelo). */
  last_step_at: z.string(),
  /** Sólo `running`: cuánto hace de su último paso, cuando se armó la respuesta. */
  idle_seconds: z.number().optional(),
  exit: z.string().optional(),
  summary: z.string().optional(),
  failure: z.string().optional(),
})
export type ExecutionAgent = z.infer<typeof ExecutionAgentSchema>

export const ExecutionSummarySchema = z.object({
  id: z.string(),
  pipeline_id: z.string(),
  status: z.enum(['running', 'paused', 'done', 'failed', 'superseded']),
  started_at: z.string(),
  closed_at: z.string().optional(),
  close_reason: z.string().optional(),
  agent_id: z.string().optional(),
  /** La salida por la que terminó el agente (`done`, `back_to_build`, `error`…). */
  exit: z.string().optional(),
  /** Lo que el agente dijo al cerrar (su resumen): el texto de una salida que no es un fallo. */
  summary: z.string().optional(),
  /** Por qué falló, si falló: el motivo del agente (`fail_turn`) o el error del runner. */
  failure: z.object({ by: z.enum(['agent', 'runtime']), message: z.string() }).optional(),
  pause: z.object({ pause_id: z.string(), expires_at: z.string().optional() }).optional(),
  usage: ExecutionUsageSchema.optional(),
  cost: ExecutionCostSchema.optional(),
  trace_id: z.string().optional(),
  /** Viva: lo último que dejó en la traza, y cuánto hace (`idle_seconds`). */
  last_step_at: z.string().optional(),
  idle_seconds: z.number().optional(),
  /** Cada agente: en una viva, siempre; en una cerrada, si corrió más de uno. Sin esto (un runner
   *  viejo, o la bandeja de una cerrada), sólo `agent_id`. */
  agents: z.array(ExecutionAgentSchema).optional(),
})
export type ExecutionSummary = z.infer<typeof ExecutionSummarySchema>

/** La épica de una tarea: su issue padre y cuántos de sus sub-issues cerraron. */
export const TaskEpicSchema = z.object({
  /** `owner/repo#n` */
  ref: z.string(),
  title: z.string(),
  /** Sub-issues cerrados. */
  done: z.number(),
  total: z.number(),
})
export type TaskEpic = z.infer<typeof TaskEpicSchema>

export const InboxItemSchema = z.object({
  /** `owner/repo#n` */
  ref: z.string(),
  project_id: z.string(),
  title: z.string(),
  url: z.string(),
  group: InboxGroupSchema,
  kind: InboxKindSchema,
  /** El Status del board. */
  status: z.string().optional(),
  labels: z.array(z.string()),
  task_type: z.string().optional(),
  /** Una línea: por qué está acá. Texto plano. */
  why: z.string(),
  /** Desde cuándo está en este estado (ISO). */
  since: z.string(),
  pr: z.object({ number: z.number(), url: z.string() }).optional(),
  execution: ExecutionSummarySchema.optional(),
  /** Los issues que la bloquean (`owner/repo#n`). */
  blocked_by: z.array(z.string()).optional(),
  /** Cuántas tareas destraba si se cierra. */
  unlocks: z.number().optional(),
  /** Su épica (el issue padre) y su avance; sin padre, ausente. */
  epic: TaskEpicSchema.optional(),
  /** Lo último que dijo el agente (su reporte o el motivo de su `fail_turn`). */
  agent_said: z.string().optional(),
  actions: z.array(TaskActionSchema),
  /** Cómo se llaman y qué piden las que declaró el proyecto (las otras las conoce el cliente). */
  action_defs: z.array(TaskActionDefSchema).optional(),
  /** Su lugar entre las decisiones (`need` + `fail`) de `GET /api/inbox`: 1 = la primera. Lo que
   *  corre, espera turno o se pide suelto (una tarea por su ref) no lo trae. */
  priority: z.number().optional(),
  /** Por qué está en ese lugar, en lenguaje de producto ("a un merge de Done", "destraba 2
   *  tareas"): al menos una cuando hay `priority`. */
  reasons: z.array(z.string()).optional(),
  // ── presentación: la pone el dashboard de quien mira (la web), nunca el runner ──
  /** El verbo de la decisión ("Decidir el merge"); sin él, el nombre del caso. */
  verb: z.string().optional(),
  /** La acción principal, la que se destaca entre `actions`. */
  primary: z.string().optional(),
  /** Una explicación más larga que `why`. */
  context: z.string().optional(),
  /** Datos sueltos que acompañan al título ("a un merge de Done"). */
  chips: z
    .array(z.object({ text: z.string(), tone: z.enum(['hot', 'warn', 'bad']).optional() }))
    .optional(),
})
export type InboxItem = z.infer<typeof InboxItemSchema>

export const InboxProjectSchema = z.object({
  id: z.string(),
  board: z.object({ owner: z.string(), number: z.number() }),
  /** La página del GitHub Project. */
  url: z.string().optional(),
  /** Su vista de tablero (la primera con layout de board); si no hay, la del Project. */
  board_url: z.string().optional(),
  /** Las columnas del board, en su orden: a dónde se puede mover o agregar una card. Un runner
   *  viejo no las manda. */
  statuses: z.array(z.string()).optional(),
  /** El catálogo de repos del proyecto (`owner/repo`): donde se abre un issue para su board. Un
   *  runner viejo no lo manda. */
  repos: z.array(z.string()).optional(),
})
export type InboxProject = z.infer<typeof InboxProjectSchema>

/** Una card del board que no está en la bandeja: sin pendientes. */
export const BoardRestItemSchema = z.object({
  ref: z.string(),
  project_id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string().optional(),
  labels: z.array(z.string()),
  updated_at: z.string(),
  pr: z.object({ number: z.number(), url: z.string() }).optional(),
  /** Cuándo se cerró (ISO): sólo las de `closed`. */
  closed_at: z.string().optional(),
})
export type BoardRestItem = z.infer<typeof BoardRestItemSchema>

/** Lo que el runner tiene corriendo y cuánto le cabe: con esto se decide con qué alimentarlo. */
export const InboxPipelineSchema = z.object({
  /** Corridas con un agente trabajando ahora. */
  running: z.number(),
  /** Corridas esperando turno (detrás de otra o del tope). */
  queued: z.number(),
  /** Corridas pausadas (esperando el CI): no ocupan un lugar, pero siguen vivas. */
  paused: z.number(),
  /** El tope global (`engine.executions.maxConcurrent`); sin tope, ausente. */
  capacity: z.number().optional(),
  /** Lugares libres: `capacity - running`; sin tope, ausente. */
  free: z.number().optional(),
})
export type InboxPipeline = z.infer<typeof InboxPipelineSchema>

/** Una card de Todo que todavía no arrancó. */
export const InboxFeedItemSchema = BoardRestItemSchema.extend({
  /** Los issues abiertos que la bloquean (`owner/repo#n`): sólo en `waiting`. */
  blocked_by: z.array(z.string()).optional(),
})
export type InboxFeedItem = z.infer<typeof InboxFeedItemSchema>

/** Las cards de Todo, en el orden del board: las que pueden arrancar ya y las que esperan a otra. */
export const InboxFeedSchema = z.object({
  ready: z.array(InboxFeedItemSchema),
  waiting: z.array(InboxFeedItemSchema),
})
export type InboxFeed = z.infer<typeof InboxFeedSchema>

export const InboxSchema = z.object({
  generated_at: z.string(),
  projects: z.array(InboxProjectSchema),
  items: z.array(InboxItemSchema),
  /** Ocupación del runner. Un runner viejo no lo manda. */
  pipeline: InboxPipelineSchema.optional(),
  /** Las cards de Todo, listas o esperando. Un runner viejo no lo manda. */
  feed: InboxFeedSchema.optional(),
})
export type Inbox = z.infer<typeof InboxSchema>

/** Qué hizo una pipeline con un evento. */
export const PipelineDecisionSchema = z.object({
  pipeline_id: z.string(),
  source_id: z.string(),
  verdict: z.enum(['ran', 'mismatch', 'lost_to_exclusive']),
  reason: z.string().optional(),
})
export type PipelineDecision = z.infer<typeof PipelineDecisionSchema>

export const EventOutcomeSchema = z.enum([
  'dispatched',
  'injected',
  'resumed',
  'skipped',
  'ignored',
  'error',
])
export type EventOutcome = z.infer<typeof EventOutcomeSchema>

/** Una fila de `event_log`: un evento que llegó al runner y qué se decidió con él. */
export const EventLogEntrySchema = z.object({
  id: z.string(),
  parent_id: z.string().optional(),
  delivery_id: z.string().optional(),
  type: z.string(),
  occurred_at: z.string(),
  depth: z.number(),
  project_id: z.string().optional(),
  task_ref: z.string().optional(),
  summary: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  outcome: EventOutcomeSchema,
  error: z.string().optional(),
  decisions: z.array(PipelineDecisionSchema),
  execution_id: z.string().optional(),
  trace_id: z.string().optional(),
})
export type EventLogEntry = z.infer<typeof EventLogEntrySchema>

/** Una fila de `execution_trace`: un span (al empezar y al terminar) o un log de una ejecución. */
export const TraceEntrySchema = z.object({
  kind: z.enum(['span', 'log']),
  phase: z.enum(['start', 'end']).optional(),
  name: z.string(),
  scope: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  status: z.enum(['ok', 'error', 'unset']).optional(),
  status_message: z.string().optional(),
  start_time: z.string(),
  end_time: z.string().optional(),
  duration_ms: z.number().optional(),
  trace_id: z.string(),
  span_id: z.string(),
  parent_span_id: z.string().optional(),
  execution_id: z.string(),
  origin: z.string(),
  attributes: z.record(z.string(), z.unknown()),
})
export type TraceEntry = z.infer<typeof TraceEntrySchema>

export const TaskDetailSchema = z.object({
  item: InboxItemSchema,
  description: z.string().optional(),
  /** De la más nueva a la más vieja. */
  executions: z.array(ExecutionSummarySchema),
  /** De lo más nuevo a lo más viejo. */
  events: z.array(EventLogEntrySchema),
  /** La traza de la última ejecución (o de `?execution=`), en orden. */
  trace: z.array(TraceEntrySchema),
})
export type TaskDetail = z.infer<typeof TaskDetailSchema>

/** "¿Por qué corrió / no corrió?": las decisiones del engine para un evento contra la card. */
export const ExplainResultSchema = z.object({
  ref: z.string(),
  event: z.object({
    type: z.string(),
    summary: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  }),
  /** De dónde salió el evento: el último que recibió la tarea, o uno armado para la pregunta. */
  source: z.enum(['last_event', 'synthetic']),
  decisions: z.array(PipelineDecisionSchema),
})
export type ExplainResult = z.infer<typeof ExplainResultSchema>

export const ConfigSummarySchema = z.object({
  projects: z.array(InboxProjectSchema),
  pipelines: z.array(
    z.object({
      id: z.string(),
      source_id: z.string(),
      name: z.string().optional(),
      on: z.array(z.string()),
      when: z.array(z.string()),
      exclusive: z.boolean(),
      position: z.number(),
      agents: z.array(z.string()),
      actions: z.array(z.string()),
    }),
  ),
  agents: z.array(
    z.object({
      id: z.string(),
      providers: z.array(z.string()),
      /** El modelo de cada provider candidato: su `providerConfig.model`, o el default del
       *  provider en runner.yaml. Un candidato sin modelo conocido no está. */
      models: z.record(z.string(), z.string()).default({}),
      routes: z.record(z.string(), z.string()),
      /** Sus MCP por id: `mounted` false si lo nombra y no quedó montado en este runner (no
       *  respondió al arrancar, o le faltó su secreto) — corre sin él. Sin URL ni headers. */
      mcp_servers: z.array(z.object({ id: z.string(), mounted: z.boolean() })).default([]),
      /** Sus tools y actions (las que el modelo puede llamar), sin las `submit_<salida>`. */
      actions: z.array(z.string()).default([]),
      /** Su prompt: los system prompts ya resueltos (unidos) y la plantilla del turno. Cada texto
       *  puede venir recortado; `*_chars` es su largo completo. */
      prompt: z
        .object({
          system: z.string(),
          system_chars: z.number(),
          task: z.string(),
          task_chars: z.number(),
        })
        .optional(),
    }),
  ),
  /** Los providers de runner.yaml, sin secretos: sólo tipo, modo, a qué provider apunta y su tope. */
  providers: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        mode: z.string().optional(),
        provider: z.string().optional(),
        max_concurrent: z.number().optional(),
      }),
    )
    .default([]),
  /** Los MCP del catálogo: su id y el host (sin path ni token: una URL puede llevar un secreto). */
  mcp: z.array(z.object({ id: z.string(), host: z.string() })).default([]),
})
export type ConfigSummary = z.infer<typeof ConfigSummarySchema>

/** Un agente del asistente: cada uno cumple su capacidad (`assistant`, `assistant.<id>`). */
export const AssistantAgentSchema = z.object({
  /** El nombre de su capacidad: `assistant` (el de siempre) o `assistant.<id>`. */
  id: z.string(),
  label: z.string(),
  /** Para qué sirve, en una frase: la web lo muestra al elegirlo. */
  description: z.string().optional(),
})
export type AssistantAgent = z.infer<typeof AssistantAgentSchema>

/** El agente del asistente que contesta cuando el pedido no nombra otro. */
export const DEFAULT_ASSISTANT_AGENT = 'assistant'

/** `GET /api/runner`: con esto el selector de servidores reconoce a un runner-v2. */
export const RunnerInfoSchema = z.object({
  service: z.literal('ia-flow-runner'),
  version: z.string(),
  projects: z.array(InboxProjectSchema),
  github_login: z.object({ device_flow: z.boolean() }),
  assistant: z.boolean(),
  /** Con quién se puede hablar en el asistente: el primero es el de siempre. Un runner viejo no
   *  lo manda: la web asume sólo el de siempre. */
  assistant_agents: z.array(AssistantAgentSchema).default([]),
})
export type RunnerInfo = z.infer<typeof RunnerInfoSchema>

export const TaskActionRequestSchema = z.object({
  action: TaskActionSchema,
  comment: z.string().optional(),
  /** El PR sobre el que actúa (`close_pr`); sin esto, el de la card. */
  pr: z.number().int().positive().optional(),
})
export type TaskActionRequest = z.infer<typeof TaskActionRequestSchema>

export const TaskActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Quién la firmó en GitHub. */
  github_login: z.string().optional(),
})
export type TaskActionResult = z.infer<typeof TaskActionResultSchema>

/** `POST /api/tasks/:owner/:repo/:n/status`: mover la card a otra columna, con el login de quien la
 *  mueve. Responde un `TaskActionResult`. */
export const MoveTaskRequestSchema = z.object({ status: z.string().min(1) })
export type MoveTaskRequest = z.infer<typeof MoveTaskRequestSchema>

/** `POST /api/board/items`: un issue que no está en el board pasa a estarlo, en `status` (sin él,
 *  la columna de Todo), con el login de quien lo agrega. */
export const AddToBoardRequestSchema = z.object({
  /** `owner/repo#n` o el link del issue. */
  issue: z.string().min(1),
  /** El proyecto del runner; con uno solo, se puede omitir. */
  project_id: z.string().optional(),
  status: z.string().min(1).optional(),
})
export type AddToBoardRequest = z.infer<typeof AddToBoardRequestSchema>

export const AddToBoardResultSchema = TaskActionResultSchema.extend({
  /** La card agregada: `owner/repo#n`. */
  ref: z.string().optional(),
  status: z.string().optional(),
})
export type AddToBoardResult = z.infer<typeof AddToBoardResultSchema>

/** `POST /api/tasks/:owner/:repo/:n/labels`: poner y sacar labels del issue, con el login de quien
 *  lo pide. Al menos uno de los dos. Responde un `TaskActionResult`. */
export const TaskLabelsRequestSchema = z
  .object({
    add: z.array(z.string().trim().min(1)).optional(),
    remove: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((request) => (request.add?.length ?? 0) + (request.remove?.length ?? 0) > 0, {
    message: 'Decí qué labels poner (add) o sacar (remove)',
  })
export type TaskLabelsRequest = z.infer<typeof TaskLabelsRequestSchema>

export const DeviceCodeSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  expires_in: z.number(),
  interval: z.number(),
})
export type DeviceCode = z.infer<typeof DeviceCodeSchema>

/**
 * El token de usuario de una GitHub App y cómo renovarlo. Con la expiración de tokens prendida
 * (el default de GitHub) dura 8 h y viene con un `refresh_token` de 6 meses; sin ella no vence y
 * no trae ninguno. Los `*_expires_in` son segundos desde que GitHub lo emitió.
 */
const GithubUserTokenFields = {
  access_token: z.string(),
  login: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
}

export const DevicePollSchema = z.object({
  status: z.enum(['pending', 'slow_down', 'ok', 'denied', 'expired']),
  ...GithubUserTokenFields,
  access_token: z.string().optional(),
  login: z.string().optional(),
})
export type DevicePoll = z.infer<typeof DevicePollSchema>

/** `POST /api/auth/github/refresh`: un token nuevo a cambio del `refresh_token`. GitHub los rota:
 *  el `refresh_token` usado y el token viejo dejan de servir. */
export const GithubRefreshRequestSchema = z.object({ refresh_token: z.string().min(1) })
export type GithubRefreshRequest = z.infer<typeof GithubRefreshRequestSchema>
export const GithubUserTokenSchema = z.object(GithubUserTokenFields)
export type GithubUserToken = z.infer<typeof GithubUserTokenSchema>

/** De qué habla el asistente: todo el runner, un proyecto o una tarea. */
export const AssistantScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('general') }),
  z.object({ kind: z.literal('project'), project_id: z.string() }),
  z.object({ kind: z.literal('task'), ref: z.string() }),
])
export type AssistantScope = z.infer<typeof AssistantScopeSchema>

export const AssistantMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
})
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>

export const AssistantRequestSchema = z.object({
  scope: AssistantScopeSchema,
  messages: z.array(AssistantMessageSchema).min(1),
  /** Con qué agente del asistente (`AssistantAgent.id`); sin esto, el de siempre. */
  agent: z.string().optional(),
  /** La conversación guardada a la que sigue esta pregunta. Se guarda sólo con login de GitHub
   *  (`x-github-token`): sin él, el chat funciona pero no queda en ningún lado. */
  conversation_id: z.string().optional(),
  /** Quien pregunta escucha la respuesta en voz alta: el asistente suma un resumen para el oído
   *  (el evento `speech`). Sin esto, o en un runner viejo, la voz lee la respuesta entera. */
  voice: z.boolean().optional(),
})
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>

/** Una acción sobre una tarea que el asistente propone: la ejecuta el usuario, con su login de
 *  GitHub. Sin `kind`: las guardadas antes de que hubiera otras propuestas no lo traen. */
export const AssistantTaskProposalSchema = z.object({
  id: z.string(),
  ref: z.string(),
  action: TaskActionSchema,
  label: z.string(),
  reason: z.string(),
  comment: z.string().optional(),
  /** El PR sobre el que actúa (`close_pr`). */
  pr: z.number().int().positive().optional(),
})
export type AssistantTaskProposal = z.infer<typeof AssistantTaskProposalSchema>

/** Un issue nuevo que el asistente propone abrir: lo crea el usuario, con su login de GitHub. */
export const AssistantIssueProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('issue'),
  /** `owner/repo` donde se abre. */
  repo: z.string(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  label: z.string(),
  reason: z.string(),
  /** Además de abrirlo, sumarlo al board de este proyecto (en `status`; sin él, Todo): la base de
   *  una tarea para refinar. La persona puede cambiar la columna antes de confirmar. */
  board: z.object({ project_id: z.string(), status: z.string().optional() }).optional(),
})
export type AssistantIssueProposal = z.infer<typeof AssistantIssueProposalSchema>

/** Mover la card de una tarea a otra columna (`POST /api/tasks/:o/:r/:n/status`). */
export const AssistantMoveProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('move'),
  ref: z.string(),
  status: z.string(),
  /** La columna en la que estaba al proponerla. */
  from: z.string().optional(),
  label: z.string(),
  reason: z.string(),
})
export type AssistantMoveProposal = z.infer<typeof AssistantMoveProposalSchema>

/** Sumar al board un issue que no está (`POST /api/board/items`). */
export const AssistantAddToBoardProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('add_to_board'),
  /** `owner/repo#n`. */
  issue: z.string(),
  project_id: z.string().optional(),
  /** Sin esto, la columna de entrada del runner (Todo). */
  status: z.string().optional(),
  label: z.string(),
  reason: z.string(),
})
export type AssistantAddToBoardProposal = z.infer<typeof AssistantAddToBoardProposalSchema>

/** Poner y sacar labels del issue de una tarea (`POST /api/tasks/:o/:r/:n/labels`). */
export const AssistantLabelsProposalSchema = z.object({
  id: z.string(),
  kind: z.literal('labels'),
  ref: z.string(),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
  label: z.string(),
  reason: z.string(),
})
export type AssistantLabelsProposal = z.infer<typeof AssistantLabelsProposalSchema>

/** Lo que el asistente propone: una acción sobre una tarea, abrir un issue, mover una card,
 *  sumar un issue al board o cambiarle labels. La de una acción va última: no trae `kind`. */
export const AssistantProposalSchema = z.union([
  AssistantIssueProposalSchema,
  AssistantMoveProposalSchema,
  AssistantAddToBoardProposalSchema,
  AssistantLabelsProposalSchema,
  AssistantTaskProposalSchema,
])
export type AssistantProposal = z.infer<typeof AssistantProposalSchema>

export type AssistantProposalKind = 'action' | 'issue' | 'move' | 'add_to_board' | 'labels'

/** Qué propone: las de una acción no traen `kind` (las guardadas antes no lo tenían). */
export function proposalKind(proposal: AssistantProposal): AssistantProposalKind {
  return 'kind' in proposal ? proposal.kind : 'action'
}

export function isIssueProposal(proposal: AssistantProposal): proposal is AssistantIssueProposal {
  return proposalKind(proposal) === 'issue'
}

export function isTaskActionProposal(
  proposal: AssistantProposal,
): proposal is AssistantTaskProposal {
  return proposalKind(proposal) === 'action'
}

/** La tarea de la que habla la propuesta (`owner/repo#n`); un issue nuevo no tiene. */
export function proposalRef(proposal: AssistantProposal): string | undefined {
  if ('ref' in proposal) return proposal.ref
  if ('issue' in proposal) return proposal.issue
  return undefined
}

/** `POST /api/issues`: abre un issue propuesto, con el token de GitHub de quien lo confirma. */
export const CreateIssueRequestSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/repo'),
  title: z.string().trim().min(1),
  body: z.string(),
  labels: z.array(z.string().min(1)).optional(),
  /** Sumarlo además al board (como `POST /api/board/items`), en `status` o Todo. */
  board: z
    .object({ project_id: z.string().optional(), status: z.string().min(1).optional() })
    .optional(),
})
export type CreateIssueRequest = z.infer<typeof CreateIssueRequestSchema>

export const CreateIssueResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** El issue creado. */
  url: z.string().optional(),
  number: z.number().optional(),
  github_login: z.string().optional(),
  /** Con `board` en el pedido: si quedó en el board y en qué columna. El issue se abre igual aunque
   *  sumarlo falle: `board_error` dice por qué. */
  board_status: z.string().optional(),
  board_error: z.string().optional(),
})
export type CreateIssueResult = z.infer<typeof CreateIssueResultSchema>

/** Lo que manda `POST /api/assistant` por SSE, un evento por línea `data:`. */
export const AssistantStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), delta: z.string() }),
  z.object({ type: z.literal('tool'), name: z.string(), summary: z.string() }),
  z.object({ type: z.literal('proposal'), proposal: AssistantProposalSchema }),
  /** Las tareas de las que habla la respuesta, como están en la bandeja: la web las muestra como
   *  cards que abren la tarea. Llega después del texto, antes de `done`. */
  z.object({ type: z.literal('tasks'), items: z.array(InboxItemSchema) }),
  /** La conversación donde quedó guardado el intercambio (sólo con login). Llega antes de `done`. */
  z.object({ type: z.literal('conversation'), id: z.string() }),
  /** Con `voice` en el pedido: lo que se dice en voz alta en vez de la respuesta (un resumen corto,
   *  sin markdown). No se muestra ni se guarda. Llega antes de `done`, si el asistente lo dio. */
  z.object({ type: z.literal('speech'), text: z.string() }),
  z.object({ type: z.literal('done'), text: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type AssistantStreamEvent = z.infer<typeof AssistantStreamEventSchema>

/** Una línea del log del proceso del runner (`createLogger`), en el buffer que sirve `GET /api/logs`. */
export const RunnerLogLineSchema = z.object({
  /** Creciente desde que arrancó el proceso: `?after=<seq>` pide sólo las nuevas. */
  seq: z.number(),
  time: z.string(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  scope: z.string(),
  /** Con los secretos tapados. */
  message: z.string(),
  /** Los atributos del log, ya como texto (`clave=valor`), tapados igual. */
  fields: z.string().optional(),
  trace_id: z.string().optional(),
})
export type RunnerLogLine = z.infer<typeof RunnerLogLineSchema>

export const RunnerLogsSchema = z.object({
  lines: z.array(RunnerLogLineSchema),
  /** El último `seq` emitido (aunque el filtro no lo devuelva): el `after` del próximo pedido. */
  last_seq: z.number(),
  /** Cuántas líneas guarda el runner: lo más viejo se pierde. */
  capacity: z.number(),
})
export type RunnerLogs = z.infer<typeof RunnerLogsSchema>

/** Lo que manda `GET /api/stream` por SSE: algo cambió y qué. */
export const RunnerStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inbox'), refs: z.array(z.string()) }),
  z.object({ type: z.literal('trace'), entry: TraceEntrySchema }),
  z.object({ type: z.literal('event'), entry: EventLogEntrySchema }),
  /** Cambiaron las mejoras propuestas (`GET /api/improvements`): una nueva, abierta o descartada. */
  z.object({ type: z.literal('improvements') }),
])
export type RunnerStreamEvent = z.infer<typeof RunnerStreamEventSchema>

/** Una conversación guardada del asistente, en la lista: de quién la tuvo (su login de GitHub). */
export const AssistantConversationSummarySchema = z.object({
  id: z.string(),
  scope: AssistantScopeSchema,
  /** Con qué agente del asistente fue (`AssistantAgent.id`). */
  agent: z.string().default(DEFAULT_ASSISTANT_AGENT),
  /** La primera pregunta, recortada. */
  title: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  messages: z.number(),
})
export type AssistantConversationSummary = z.infer<typeof AssistantConversationSummarySchema>

/** Un mensaje guardado. Las tareas vienen como están AHORA en la bandeja, no como estaban. */
export const AssistantStoredMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  created_at: z.string(),
  proposals: z.array(AssistantProposalSchema),
  tasks: z.array(InboxItemSchema),
})
export type AssistantStoredMessage = z.infer<typeof AssistantStoredMessageSchema>

export const AssistantConversationSchema = AssistantConversationSummarySchema.extend({
  /** En orden: de la primera pregunta a la última respuesta. */
  thread: z.array(AssistantStoredMessageSchema),
})
export type AssistantConversation = z.infer<typeof AssistantConversationSchema>

/** `GET /api/board`: lo que la bandeja no muestra, por columna y en el orden del board. */
export const BoardRestSchema = z.object({
  columns: z.array(z.object({ status: z.string(), items: z.array(BoardRestItemSchema) })),
  /** Con `?closed=1`: las cards cerradas del board, las más recientes primero (hasta 100 por
   *  board). Sin el parámetro, o con un runner viejo, ausente. */
  closed: z.array(BoardRestItemSchema).optional(),
})
export type BoardRest = z.infer<typeof BoardRestSchema>

/** Un issue abierto de un repo del catálogo de un proyecto que todavía no tiene card en su board. */
export const RepoIssueSchema = z.object({
  /** `owner/repo#n` */
  ref: z.string(),
  project_id: z.string(),
  title: z.string(),
  url: z.string(),
  labels: z.array(z.string()),
  updated_at: z.string(),
  /** El login de quien lo abrió. */
  author: z.string().optional(),
})
export type RepoIssue = z.infer<typeof RepoIssueSchema>

/** `GET /api/repos/issues`: por repo del catálogo (`projects[].repos`), sus issues abiertos sin card
 *  en el board —ni PRs ni cerrados—, el más reciente primero. Así ningún issue de un repo que el
 *  runner maneja queda fuera de la vista. */
export const RepoIssuesSchema = z.object({
  repos: z.array(
    z.object({
      /** `owner/repo` */
      repo: z.string(),
      project_id: z.string(),
      items: z.array(RepoIssueSchema),
      /** El repo tiene más de los que se trajeron (tope por repo). */
      truncated: z.boolean().optional(),
      /** No se pudo leer el repo (sin acceso, no existe…): el resto sí. */
      error: z.string().optional(),
    }),
  ),
})
export type RepoIssues = z.infer<typeof RepoIssuesSchema>

/** Una entrada del runner: por dónde le llegan los eventos de afuera. */
export const IngressSourceSchema = z.object({
  /** `github` o `slack`: el prefijo de los eventos crudos que entran por acá (`github.push`…). */
  id: z.string(),
  name: z.string(),
  /** `webhook` (GitHub le hace POST al runner) o `socket` (el runner abre la conexión, Slack). */
  kind: z.enum(['webhook', 'socket']),
  /** Dónde escucha, si es un webhook: el path al que GitHub manda. */
  endpoint: z.string().optional(),
  /** Si tiene lo que necesita para funcionar (el secret del webhook, el app token de Slack). */
  configured: z.boolean(),
  /** Qué falta, si no está configurada. */
  missing: z.string().optional(),
  last_at: z.string().optional(),
  count_24h: z.number(),
  /** Cuántos quedan guardados (los de los últimos `retention_days`). */
  count_kept: z.number(),
})
export type IngressSource = z.infer<typeof IngressSourceSchema>

/** `GET /api/ingress`: las entradas del runner y cuánto les llega. */
export const IngressSchema = z.object({
  sources: z.array(IngressSourceSchema),
  retention_days: z.number(),
})
export type Ingress = z.infer<typeof IngressSchema>
