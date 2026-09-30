/**
 * El cable entre `RemoteProvider` (el runner) y `RemoteProviderHost` (la máquina que corre el
 * modelo). Todo lo que cruza se declara acá, una vez, en zod: los dos lados validan con lo mismo.
 *
 *   GET    /v1/providers                       qué providers expone el host
 *   GET    /v1/providers/:id/capacity?<hints>  si tomaría una corrida ahora (consultivo)
 *   POST   /v1/providers/:id/runs              abre una corrida → 202 { runId } | 503 (al tope)
 *   POST   /v1/runs/:runId/sync                el ida y vuelta de una corrida (long-poll)
 *   DELETE /v1/runs/:runId                     la corta (si sigue) y la olvida
 *
 * Todo con `Authorization: Bearer <token>`. Nadie más que el runner inicia conexiones: las tools
 * del agente viajan como eventos `tool_call` en la respuesta del sync y sus resultados en el
 * siguiente — el host nunca necesita alcanzar al runner, ni tener con qué autenticarse contra él.
 */
import type { DomainEvent } from '@ia-flow/agent-engine'
import type { TraceRecord } from '@ia-flow/telemetry'
import { z } from 'zod'

export const PROTOCOL_PREFIX = '/v1'

/** Las pistas de una corrida para decidir si el host la toma: `agentId`, `eventType` y lo que el
 *  runner agregue (ej. `repo`). Viajan en la query de la sonda Y en el body de la corrida, para
 *  que una regla dé lo mismo en los dos lugares. */
export const AdmissionHints = z.record(z.string(), z.array(z.string()))
export type AdmissionHints = z.infer<typeof AdmissionHints>

export const CapacityResponse = z.object({
  accepting: z.boolean(),
  reason: z.string().optional(),
  retryAfterMs: z.number().nonnegative().optional(),
})
export type CapacityResponse = z.infer<typeof CapacityResponse>

/** Una tool del agente, sin su `handler`: el handler corre en el runner. */
export const ToolSpec = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  terminal: z.boolean().optional(),
  failure: z.boolean().optional(),
  /** Opera sobre el worktree (`Tool.workspace`): el host no se la da a un provider nativo. */
  workspace: z.boolean().optional(),
})
export type ToolSpec = z.infer<typeof ToolSpec>

const AgentVariable = z.union([
  z.string(),
  z.object({ value: z.string(), full: z.string().optional(), description: z.string().optional() }),
])

/** Lo del `PipelineExecutionContext` que cruza: el evento (del que el host deriva, p. ej., el
 *  worktree) y de qué pipeline viene. El resto (`bus`, `steps`, las ejecuciones) es del runner. */
export const RunContextWire = z.object({
  event: z.object({
    /** Opcional: un runner anterior a los ids de evento no lo manda. */
    id: z.string().optional(),
    parentId: z.string().optional(),
    type: z.string(),
    payload: z.unknown(),
    scope: z.record(z.string(), z.unknown()).optional(),
    occurredAt: z.string(),
    depth: z.number(),
    executionId: z.string().optional(),
  }),
  pipelineId: z.string(),
  sourceId: z.string().optional(),
  executionId: z.string().optional(),
})
export type RunContextWire = z.infer<typeof RunContextWire>

/** El evento del wire como `DomainEvent`: un runner anterior a los ids no lo manda, y acá se le
 *  inventa uno para que el provider de este lado siempre tenga `event.id`. */
export function toDomainEvent(event: RunContextWire['event']): DomainEvent {
  return { ...event, id: event.id ?? globalThis.crypto.randomUUID() } as DomainEvent
}

export const RunRequest = z.object({
  agentId: z.string(),
  prompt: z.string(),
  systemPrompts: z.array(z.string()),
  variables: z.record(z.string(), AgentVariable),
  providerConfig: z.record(z.string(), z.unknown()),
  mcpServers: z.array(z.object({ id: z.string(), config: z.record(z.string(), z.unknown()) })),
  tools: z.array(ToolSpec),
  context: RunContextWire,
  hints: AdmissionHints,
  /** El runner tiene inbox para esta corrida: el host le da uno al provider de allá. */
  inbox: z.boolean(),
  /** El runner guarda la conversación: el host le da `saveConversation` al provider de allá. */
  saveConversation: z.boolean(),
  resume: z.object({ conversation: z.unknown(), message: z.string() }).optional(),
  /** El span del agente en el runner (W3C `traceparent`): el provider de allá corre como su hijo,
   *  en la misma traza. */
  traceparent: z.string().optional(),
  /** El runner quiere ver lo que pasa allá mientras pasa: el host le manda eventos `trace` (sus
   *  spans y logs de esta ejecución) y `text` (el texto del modelo). Un runner viejo no lo pide y
   *  un host viejo lo ignora. */
  observe: z.boolean().optional(),
})
export type RunRequest = z.infer<typeof RunRequest>

const TraceValueWire = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean()),
])

/** Un `TraceRecord` de `@ia-flow/telemetry` en el cable: un span (al empezar o al terminar) o un
 *  log del host, de la ejecución de la corrida. */
export const TraceRecordWire = z.object({
  kind: z.enum(['span', 'log']),
  phase: z.enum(['start', 'end']).optional(),
  name: z.string(),
  scope: z.string().optional(),
  level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  status: z.enum(['ok', 'error', 'unset']).optional(),
  statusMessage: z.string().optional(),
  startTime: z.string(),
  endTime: z.string().optional(),
  durationMs: z.number().optional(),
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().optional(),
  executionId: z.string(),
  origin: z.string(),
  attributes: z.record(z.string(), TraceValueWire),
}) satisfies z.ZodType<TraceRecord>

export const RunAccepted = z.object({ runId: z.string() })

export const RunOutputWire = z.object({
  outcome: z.string(),
  summary: z.string().optional(),
  structuredOutput: z.record(z.string(), z.unknown()).optional(),
  conversation: z.unknown().optional(),
})

/** Lo que pasa en una corrida, en orden (`seq`). El runner los reconoce mandando `after`. */
export const RunEvent = z.discriminatedUnion('type', [
  z.object({
    seq: z.number(),
    type: z.literal('tool_call'),
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ seq: z.number(), type: z.literal('conversation'), conversation: z.unknown() }),
  z.object({ seq: z.number(), type: z.literal('done'), output: RunOutputWire }),
  z.object({ seq: z.number(), type: z.literal('failed'), error: z.string() }),
  /** Sólo con `observe`: un span o log del host, apenas pasa. */
  z.object({ seq: z.number(), type: z.literal('trace'), record: TraceRecordWire }),
  /** Sólo con `observe`: el texto del modelo a medida que se escribe (`ProviderRunContext.onText`). */
  z.object({ seq: z.number(), type: z.literal('text'), delta: z.string() }),
])
export type RunEvent = z.infer<typeof RunEvent>

export const ToolResult = z.object({
  callId: z.string(),
  text: z.string(),
  isError: z.boolean(),
})
export type ToolResult = z.infer<typeof ToolResult>

export const SyncRequest = z.object({
  /** El último `seq` que el runner ya procesó: el host devuelve los que siguen. Reenviar el mismo
   *  `after` es seguro — un sync cortado a mitad de camino no pierde eventos. */
  after: z.number(),
  results: z.array(ToolResult).default([]),
  /** Lo que llegó al inbox de la ejecución y el host todavía no confirmó. */
  inbox: z.array(z.string()).default([]),
  /** La posición de `inbox[0]` en todo lo que el runner le mandó a esta corrida: con eso el host
   *  descarta lo que ya había recibido si un sync se reenvía. */
  inboxFrom: z.number().int().min(0).default(0),
  /** Cuánto puede esperar el host por un evento nuevo antes de contestar vacío. */
  waitMs: z.number().int().min(0).max(60_000).default(0),
})
export type SyncRequest = z.infer<typeof SyncRequest>

export const SyncResponse = z.object({ events: z.array(RunEvent) })
export type SyncResponse = z.infer<typeof SyncResponse>

/** `?agentId=a&eventType=b&repo=x&repo=y` ⇄ `{ agentId: ['a'], … }`. Una pista vacía viaja
 *  como `key=` a secas: "vino vacía" no es lo mismo que "no vino" (ver `evaluateAdmission`). */
export function hintsToQuery(hints: AdmissionHints): URLSearchParams {
  const query = new URLSearchParams()
  for (const [key, values] of Object.entries(hints)) {
    if (values.length === 0) query.append(key, '')
    for (const value of values) query.append(key, value)
  }
  return query
}

export function hintsFromQuery(query: URLSearchParams): AdmissionHints {
  const hints: AdmissionHints = {}
  for (const [key, value] of query) {
    const values = (hints[key] ??= [])
    if (value !== '') values.push(value)
  }
  return hints
}
