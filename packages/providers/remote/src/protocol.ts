/**
 * El cable entre un runner y sus hosts, en zod: lo validan los dos lados. Todas las conexiones las
 * abre el HOST — sólo necesita salida; el runner ya es público (recibe los webhooks de GitHub):
 *
 *   POST /v1/hosts/subscribe            (bearer de hosts) me llamo X, tomo esto, hasta N a la vez
 *   POST /v1/hosts/<session>/poll       (bearer de hosts) long-poll: tareas nuevas y corridas cerradas
 *   POST /v1/runs/<token>/mcp           el MCP de la corrida (las tools del agente)       ┐ el token de
 *   POST /v1/runs/<token>/hooks/<Ev>    los hooks de Claude Code (traza, inbox, cierre)   │ la corrida, en
 *   POST /v1/runs/<token>/transcript    los requests al modelo (uso) que el host lee de    │ el path
 *                                       la transcripción de su sesión                      │
 *   POST /v1/runs/<token>/report        cómo terminó la sesión del lado del host          ┘
 *
 * El runner no conduce nada: le entrega la tarea al host y espera en el canal de la corrida (el de
 * `@ia-flow/provider-shared`, el mismo que usa el CLI local) a que el modelo llame una tool
 * terminal — como un `claude` corriendo en su máquina, pero contra una API.
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

/** Una corrida para el host: lo que necesita para lanzar la sesión, y dónde hablarle al runner. */
export const HostTask = z.strictObject({
  runId: z.string(),
  agentId: z.string(),
  /** `<agente>-task-<n>`: el nombre de la sesión. */
  label: z.string(),
  prompt: z.string(),
  systemPrompts: z.array(z.string()),
  /** Las tools que cierran el turno (para la nota de sesión desatendida). */
  exits: z.array(z.string()),
  /** Los MCP externos del agente, con sus credenciales ya resueltas. */
  mcpServers: z.array(
    z.strictObject({ id: z.string(), config: z.record(z.string(), z.unknown()) }),
  ),
  /** Su `providerConfig`: lo valida el host, que es el que sabe qué acepta. */
  providerConfig: z.record(z.string(), z.unknown()),
  /** El evento de la corrida: de él sale el worktree, como en el runner. */
  event: z.strictObject({
    id: z.string(),
    type: z.string(),
    payload: z.unknown(),
    scope: z.record(z.string(), z.unknown()).optional(),
    occurredAt: z.string(),
  }),
  /** La sesión del CLI: una nueva con ese id, o retomar la que tiene ese id. */
  session: z.strictObject({ id: z.string(), resume: z.boolean() }),
  /** Paths en el runner (relativos a su base): el MCP, los hooks, la transcripción y el reporte
   *  de la corrida. Sin `transcript` (un runner viejo), el host no reenvía el uso. */
  endpoints: z.strictObject({
    mcp: z.string(),
    hooks: z.string(),
    transcript: z.string().optional(),
    report: z.string(),
  }),
})
export type HostTask = z.infer<typeof HostTask>

export const PollResponse = z.strictObject({
  tasks: z.array(HostTask),
  /** Corridas que el runner ya dio por terminadas: el host corta sus sesiones. */
  closed: z.array(z.string()),
})
export type PollResponse = z.infer<typeof PollResponse>

/** Cómo terminó la sesión del lado del host (o que no pudo arrancar). */
export const RunReport = z.strictObject({
  status: z.enum(['exited', 'failed']),
  /** `exited`: el código del proceso, si se sabe. */
  code: z.number().nullable().optional(),
  /** Qué pasó, para el resumen de la corrida. */
  message: z.string().optional(),
})
export type RunReport = z.infer<typeof RunReport>

/** Los requests al modelo de una sesión, como los arma `TranscriptTail` en el host: cada uno con su
 *  uso y su texto. El runner los registra como spans `chat <model>` de la corrida. */
export const TranscriptPost = z.strictObject({
  messages: z.array(
    z.strictObject({
      id: z.string(),
      model: z.string().optional(),
      usage: z.strictObject({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cacheReadTokens: z.number(),
        cacheCreationTokens: z.number(),
      }),
      texts: z.array(z.string()),
      timestamp: z.string().optional(),
      sidechain: z.boolean(),
    }),
  ),
})
export type TranscriptPost = z.infer<typeof TranscriptPost>
