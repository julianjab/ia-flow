/**
 * El cable entre un runner y sus hosts, en zod: lo validan los dos lados. Todas las conexiones las
 * abre el HOST — sólo necesita salida; el runner ya es público (recibe los webhooks de GitHub):
 *
 *   POST /v1/hosts/subscribe              (bearer de hosts) me llamo X, tomo esto, hasta N a la vez
 *   POST /v1/hosts/<session>/poll         (bearer de hosts) long-poll: tareas nuevas y corridas cerradas
 *   POST /v1/runs/<token>/tools           una tool del engine (`submit_*`, GitHub…)   ┐ el token de la
 *   POST /v1/runs/<token>/inbox           lo que llegó a la ejecución (sus `injects`) │ corrida, en el
 *   POST /v1/runs/<token>/conversation    la conversación en curso, para retomarla    │ path
 *   POST /v1/runs/<token>/text            el texto del modelo, en vivo                │
 *   POST /v1/runs/<token>/result          cómo terminó: el `ProviderRunOutput`        ┘
 *   POST /v1/hosts/telemetry/traces       (bearer de hosts) OTLP/HTTP JSON estándar: las trazas
 *   POST /v1/hosts/telemetry/logs         y los logs del host, que el runner guarda y reexporta
 *
 * Una tarea es la corrida de un agente, no la de un CLI: el host la corre con SU provider (el de
 * su runner.yaml — el CLI `claude`, la Messages API…) igual que el runner corre el suyo, sobre su
 * worktree. Las tools de workspace (`fs_*`, `bash_run`) viajan como `origin` y el host las rearma
 * ahí; las del engine se quedan en el runner y se llaman por `/tools`.
 */
import { z } from 'zod'

export const PROTOCOL_PREFIX = '/v1'

/** Un nombre de host: termina siendo el provider `remote:<name>`. */
export const HostName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'minúsculas, dígitos y guiones (empieza con letra o dígito)')

/** Una condición de las que acepta el host, con la forma del `when` de las pipelines. */
export const AcceptRow = z.strictObject({
  field: z.string().min(1),
  op: z.enum([
    'eq',
    'neq',
    'exists',
    'notExists',
    'in',
    'notIn',
    'contains',
    'notContains',
    'matches',
    'gt',
    'gte',
    'lt',
    'lte',
  ]),
  value: z.unknown().optional(),
  valueFrom: z.string().optional(),
  logic: z.enum(['and', 'or']).optional(),
})
export type AcceptRow = z.infer<typeof AcceptRow>

export const SubscribeRequest = z.strictObject({
  name: HostName,
  /** Cuántas corridas a la vez toma. */
  maxConcurrent: z.number().int().positive().default(1),
  /** Qué trabajo toma: condiciones sobre el payload del evento, más `agentId` y `eventType`. Sin
   *  condiciones, todo. */
  accepts: z.array(AcceptRow).default([]),
})
export type SubscribeRequest = z.infer<typeof SubscribeRequest>

export const SubscribeResponse = z.strictObject({
  /** Va en el path del poll; una suscripción nueva del mismo host lo reemplaza. */
  session: z.string(),
  /** El provider con el que lo nombran los agentes (`remote:<name>`). */
  provider: z.string(),
  /** Si no vuelve a pedir tareas en este plazo, el runner lo da por ido. */
  leaseMs: z.number().int().positive(),
})
export type SubscribeResponse = z.infer<typeof SubscribeResponse>

export const PollRequest = z.strictObject({
  /** Las corridas que el host todavía tiene en curso. */
  running: z.array(z.string()).default([]),
})
export type PollRequest = z.infer<typeof PollRequest>

/** Una tool del engine, como la ve el modelo del host: se corre en el runner (`/tools`). */
export const ToolSpec = z.strictObject({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  /** Cierra el turno (`submit_*`, `wait_for_event`, `fail_turn`…). */
  terminal: z.boolean().optional(),
  /** Lo cierra como falla (`fail_turn`). */
  failure: z.boolean().optional(),
})
export type ToolSpec = z.infer<typeof ToolSpec>

/** Una tool de workspace (`fs_*`, `bash_run`…): el host la rearma sobre su worktree con esto. */
export const WorkspaceToolSpec = z.strictObject({
  name: z.string(),
  origin: z.strictObject({
    action: z.string(),
    options: z.record(z.string(), z.unknown()),
  }),
})
export type WorkspaceToolSpec = z.infer<typeof WorkspaceToolSpec>

const AgentVariable = z.union([
  z.string(),
  z.strictObject({
    value: z.string(),
    full: z.string().optional(),
    description: z.string().optional(),
  }),
])

/** Una corrida para el host: el `ProviderRunContext` del agente, en JSON, y dónde hablarle al
 *  runner. */
export const HostTask = z.strictObject({
  runId: z.string(),
  agentId: z.string(),
  prompt: z.string(),
  systemPrompts: z.array(z.string()),
  variables: z.record(z.string(), AgentVariable),
  /** Los MCP externos del agente, con sus credenciales ya resueltas. */
  mcpServers: z.array(
    z.strictObject({ id: z.string(), config: z.record(z.string(), z.unknown()) }),
  ),
  /** Su `providerConfig`: lo valida el provider del host, que es el que sabe qué acepta. */
  providerConfig: z.record(z.string(), z.unknown()),
  tools: z.array(ToolSpec),
  workspaceTools: z.array(WorkspaceToolSpec),
  /** Retomar una conversación (opaca: la armó el provider del host y la guardó por
   *  `/conversation`) con lo que pasó mientras tanto. */
  resume: z.strictObject({ conversation: z.unknown(), message: z.string() }).optional(),
  /** El evento de la corrida: de él sale el worktree, como en el runner. */
  event: z.strictObject({
    id: z.string(),
    type: z.string(),
    payload: z.unknown(),
    scope: z.record(z.string(), z.unknown()).optional(),
    occurredAt: z.string(),
  }),
  /** El carril (`ctx.lane`): el miembro de un grupo `parallel`. El host lo usa para darle su propio
   *  worktree, como el runner — sin él, dos miembros en el mismo host compartirían el de la task. */
  lane: z.string().optional(),
  /** Paths en el runner (relativos a su base) de la corrida. */
  endpoints: z.strictObject({
    tools: z.string(),
    inbox: z.string(),
    conversation: z.string(),
    text: z.string(),
    result: z.string(),
  }),
  /** El span del agente en el runner (W3C `traceparent`) y sus atributos heredados
   *  (`ia.execution.id`, `ia.issue`…): lo que el host traza y loguea cuelga de ahí, igual que en
   *  el runner. */
  trace: z
    .strictObject({
      traceparent: z.string(),
      attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    })
    .optional(),
})
export type HostTask = z.infer<typeof HostTask>

export const PollResponse = z.strictObject({
  tasks: z.array(HostTask),
  /** Corridas que el runner ya dio por terminadas (venció, se perdió): el host las corta. */
  closed: z.array(z.string()),
})
export type PollResponse = z.infer<typeof PollResponse>

/** `POST /tools`: una tool del engine. */
export const ToolCall = z.strictObject({ name: z.string(), input: z.unknown().optional() })
export type ToolCall = z.infer<typeof ToolCall>
/** Su resultado; un error vuelve como texto con `isError`, para que el modelo lo lea. */
export const ToolResult = z.strictObject({ text: z.string(), isError: z.boolean() })
export type ToolResult = z.infer<typeof ToolResult>

/** `POST /inbox`: lo que llegó desde la última vez (y el runner lo saca de la bandeja). */
export const InboxResponse = z.strictObject({ messages: z.array(z.string()) })
export type InboxResponse = z.infer<typeof InboxResponse>

/** `POST /conversation`: la conversación en curso (opaca), para retomarla si algo se corta. */
export const ConversationPost = z.strictObject({ conversation: z.unknown() })
export type ConversationPost = z.infer<typeof ConversationPost>

/** `POST /text`: el texto del modelo a medida que se escribe, en orden. */
export const TextPost = z.strictObject({ deltas: z.array(z.string()) })
export type TextPost = z.infer<typeof TextPost>

/** `POST /result`: lo que devolvió el provider del host, o que no pudo correrla. */
export const RunResult = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('output'),
    output: z.strictObject({
      outcome: z.string(),
      summary: z.string().optional(),
      structuredOutput: z.record(z.string(), z.unknown()).optional(),
      conversation: z.unknown().optional(),
    }),
  }),
  z.strictObject({ status: z.literal('failed'), message: z.string() }),
])
export type RunResult = z.infer<typeof RunResult>
