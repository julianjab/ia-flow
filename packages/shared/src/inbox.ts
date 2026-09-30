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
 * - need: `merge` (Review + reviewed), `prd` (Refined), `doubt` (blocked por una salida de error
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
  'stale',
  'crash',
  'agent',
  'ci',
  'turn',
  'dep',
  'idle',
])
export type InboxKind = z.infer<typeof InboxKindSchema>

/** Lo que se puede hacer sobre una tarea desde la bandeja (y proponer el asistente). */
export const TaskActionSchema = z.enum([
  'merge',
  'approve_prd',
  'back_to_refine',
  'answer_and_unblock',
  'relaunch',
  'retry',
  'stop',
  /** Vuelve a correr el reviewer, como si la card acabara de llegar a Review. */
  'rerun_review',
])
export type TaskAction = z.infer<typeof TaskActionSchema>

export const ExecutionUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_tokens: z.number(),
})
export type ExecutionUsage = z.infer<typeof ExecutionUsageSchema>

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
  /** Por qué falló, si falló: el motivo del agente (`fail_turn`) o el error del runner. */
  failure: z.object({ by: z.enum(['agent', 'runtime']), message: z.string() }).optional(),
  pause: z.object({ pause_id: z.string(), expires_at: z.string().optional() }).optional(),
  usage: ExecutionUsageSchema.optional(),
  trace_id: z.string().optional(),
})
export type ExecutionSummary = z.infer<typeof ExecutionSummarySchema>

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
  /** Lo último que dijo el agente (su reporte o el motivo de su `fail_turn`). */
  agent_said: z.string().optional(),
  actions: z.array(TaskActionSchema),
})
export type InboxItem = z.infer<typeof InboxItemSchema>

export const InboxProjectSchema = z.object({
  id: z.string(),
  board: z.object({ owner: z.string(), number: z.number() }),
  /** La página del GitHub Project. */
  url: z.string().optional(),
  /** Su vista de tablero (la primera con layout de board); si no hay, la del Project. */
  board_url: z.string().optional(),
})
export type InboxProject = z.infer<typeof InboxProjectSchema>

export const InboxSchema = z.object({
  generated_at: z.string(),
  projects: z.array(InboxProjectSchema),
  items: z.array(InboxItemSchema),
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
      routes: z.record(z.string(), z.string()),
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

/** `GET /api/runner`: con esto el selector de servidores reconoce a un runner-v2. */
export const RunnerInfoSchema = z.object({
  service: z.literal('ia-flow-runner'),
  version: z.string(),
  projects: z.array(InboxProjectSchema),
  github_login: z.object({ device_flow: z.boolean() }),
  assistant: z.boolean(),
})
export type RunnerInfo = z.infer<typeof RunnerInfoSchema>

export const TaskActionRequestSchema = z.object({
  action: TaskActionSchema,
  comment: z.string().optional(),
})
export type TaskActionRequest = z.infer<typeof TaskActionRequestSchema>

export const TaskActionResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  /** Quién la firmó en GitHub. */
  github_login: z.string().optional(),
})
export type TaskActionResult = z.infer<typeof TaskActionResultSchema>

export const DeviceCodeSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  expires_in: z.number(),
  interval: z.number(),
})
export type DeviceCode = z.infer<typeof DeviceCodeSchema>

export const DevicePollSchema = z.object({
  status: z.enum(['pending', 'slow_down', 'ok', 'denied', 'expired']),
  access_token: z.string().optional(),
  login: z.string().optional(),
})
export type DevicePoll = z.infer<typeof DevicePollSchema>

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
  /** La conversación guardada a la que sigue esta pregunta. Se guarda sólo con login de GitHub
   *  (`x-github-token`): sin él, el chat funciona pero no queda en ningún lado. */
  conversation_id: z.string().optional(),
})
export type AssistantRequest = z.infer<typeof AssistantRequestSchema>

/** Una acción que el asistente propone: la ejecuta el usuario, con su login de GitHub. */
export const AssistantProposalSchema = z.object({
  id: z.string(),
  ref: z.string(),
  action: TaskActionSchema,
  label: z.string(),
  reason: z.string(),
  comment: z.string().optional(),
})
export type AssistantProposal = z.infer<typeof AssistantProposalSchema>

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
  z.object({ type: z.literal('done'), text: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type AssistantStreamEvent = z.infer<typeof AssistantStreamEventSchema>

/** Lo que manda `GET /api/stream` por SSE: algo cambió y qué. */
export const RunnerStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inbox'), refs: z.array(z.string()) }),
  z.object({ type: z.literal('trace'), entry: TraceEntrySchema }),
  z.object({ type: z.literal('event'), entry: EventLogEntrySchema }),
])
export type RunnerStreamEvent = z.infer<typeof RunnerStreamEventSchema>

/** Una conversación guardada del asistente, en la lista: de quién la tuvo (su login de GitHub). */
export const AssistantConversationSummarySchema = z.object({
  id: z.string(),
  scope: AssistantScopeSchema,
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

/** Una card del board que no está en la bandeja: sin pendientes, o de otro engine. */
export const BoardRestItemSchema = z.object({
  ref: z.string(),
  project_id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string().optional(),
  labels: z.array(z.string()),
  updated_at: z.string(),
  pr: z.object({ number: z.number(), url: z.string() }).optional(),
  /** Sin la label del proyecto: es de otro engine (se ve, pero este runner no la toca). */
  foreign: z.boolean(),
})
export type BoardRestItem = z.infer<typeof BoardRestItemSchema>

/** `GET /api/board`: lo que la bandeja no muestra, por columna y en el orden del board. */
export const BoardRestSchema = z.object({
  columns: z.array(z.object({ status: z.string(), items: z.array(BoardRestItemSchema) })),
})
export type BoardRest = z.infer<typeof BoardRestSchema>

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
