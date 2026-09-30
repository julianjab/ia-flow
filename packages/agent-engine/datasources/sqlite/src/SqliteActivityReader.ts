import type {
  DispatchDecision,
  ExecutionRecord,
  ExecutionStatus,
  PauseJSON,
} from '@ia-flow/agent-engine'
import type { TraceRecord, TraceValue } from '@ia-flow/telemetry'
import { migrate } from './migrations.js'
import type { SqliteDatabase } from './SqliteDatabase.js'
import type { EventLogOutcome, EventSummaryValue } from './SqliteDispatchJournal.js'

/** Una fila de `event_log`: un evento y qué se decidió con él. */
export interface LoggedEvent {
  id: string
  parentId?: string
  deliveryId?: string
  type: string
  occurredAt: string
  depth: number
  projectId?: string
  /** `owner/repo#n` — el `issue` del scope. */
  taskRef?: string
  summary: Record<string, EventSummaryValue>
  outcome: EventLogOutcome
  error?: string
  decisions: DispatchDecision[]
  executionId?: string
  traceId?: string
  recordedAt: string
}

/** Un evento con lo necesario para volver a despacharlo (`createEvent(type, payload, { id,
 *  scope, … })`). `payload` sólo si se guardó (ver `SqliteDispatchJournalOptions.keepPayload`). */
export interface StoredEvent extends LoggedEvent {
  scope?: Record<string, unknown>
  payload?: unknown
}

/** Un registro de la traza de una ejecución, con su orden (`seq`): para pedir lo que sigue. */
export interface StoredTraceRecord extends TraceRecord {
  seq: number
}

/** Una ejecución como la cuenta la actividad: su registro (sin el checkpoint) y de qué task es. */
export interface ExecutionOverview extends Omit<ExecutionRecord, 'checkpoint'> {
  taskRef?: string
  projectId?: string
}

export interface ExecutionUsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/**
 * Cómo terminó el agente de una ejecución — del último span `agent <id>` que terminó
 * (`ia.step.kind = agent`). Los atributos los pone `stepTrace` del core:
 * - `ia.agent.id`: el agente; `ia.agent.exit`: la salida que eligió (`submit_<salida>`; el span
 *   event `route` repite el nombre como `ia.route.exit`, pero no es un atributo del span);
 *   `ia.agent.outcome`: lo que reportó el provider; `ia.agent.summary`: su resumen.
 * - Si falló, el span queda en ERROR y el motivo es su mensaje de estado: un `fail_turn` del
 *   modelo llega como "Agent(<id>): el agente declaró que falló: <motivo>" (`by: agent`); cualquier
 *   otro error es del runtime. `ia.step.error_handled` dice qué lo cubrió (un `onError`).
 * - `ia.agent.interrupted_by` si cedió su turno; `ia.agent.waiting` si pausó esperando un evento.
 */
export interface AgentOutcome {
  agentId: string
  exit?: string
  outcome?: string
  summary?: string
  status?: 'ok' | 'error' | 'unset'
  failure?: { by: 'agent' | 'runtime'; message: string }
  errorHandledBy?: string
  interruptedBy?: string
  waiting?: string
  endTime?: string
}

export interface PruneResult {
  events: number
  traces: number
  executions: number
}

const AGENT_FAILURE = /el agente declaró que falló: ([\s\S]*)$/

interface EventRow {
  id: string
  parent_id: string | null
  delivery_id: string | null
  type: string
  occurred_at: string
  depth: number
  project_id: string | null
  task_ref: string | null
  summary_json: string
  scope_json: string | null
  payload_json: string | null
  outcome: EventLogOutcome
  error: string | null
  decisions_json: string
  execution_id: string | null
  trace_id: string | null
  recorded_at: string
}

interface TraceRow {
  seq: number
  execution_id: string
  kind: TraceRecord['kind']
  phase: TraceRecord['phase'] | null
  name: string
  scope: string | null
  level: TraceRecord['level'] | null
  status: TraceRecord['status'] | null
  status_message: string | null
  start_time: string
  end_time: string | null
  duration_ms: number | null
  trace_id: string
  span_id: string
  parent_span_id: string | null
  origin: string
  attributes_json: string
}

interface ExecutionRow {
  id: string
  key: string
  pipeline_id: string
  status: ExecutionStatus
  started_at: string
  waited_ms: number
  closed_at: string | null
  close_reason: string | null
  pause_json: string | null
}

/** Una ejecución cuya `key` (JSON de pares `[clave, valor]`) tiene `['issue', $taskRef]`. Sin
 *  JSON válido (una `executionKey` propia de la app), no matchea — en vez de romper la consulta. */
const TASK_FILTER = `($taskRef IS NULL OR CASE WHEN json_valid(e.key) THEN EXISTS (
    SELECT 1 FROM json_each(e.key) AS pair
    WHERE pair.type = 'array'
      AND CASE WHEN pair.type = 'array' THEN json_extract(pair.value, '$[0]') END = 'issue'
      AND CASE WHEN pair.type = 'array' THEN CAST(json_extract(pair.value, '$[1]') AS TEXT) END = $taskRef
  ) ELSE 0 END)`

/**
 * Lo que pasó, leído de SQLite: los eventos (`event_log`), la traza de cada ejecución
 * (`execution_trace`) y las ejecuciones (`executions`). Es el lado de lectura de
 * `SqliteDispatchJournal`, `SqliteTraceJournal` y `SqliteExecutionRepository` — sobre la misma
 * base —, para contestar "¿qué pasó con este evento / esta task?". Sin estado propio.
 */
export class SqliteActivityReader {
  constructor(private readonly db: SqliteDatabase) {
    migrate(db)
  }

  /** Los eventos de una task, del más nuevo al más viejo. */
  eventsForTask(taskRef: string, limit = 50): LoggedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM event_log WHERE task_ref = $taskRef
         ORDER BY occurred_at DESC, recorded_at DESC LIMIT $limit`,
      )
      .all({ $taskRef: taskRef, $limit: limit }) as EventRow[]
    return rows.map(toEntry)
  }

  /** Los eventos de una entrega (un webhook) — el original y los que derivaron de él, en orden. */
  eventsForDelivery(deliveryId: string): LoggedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM event_log WHERE delivery_id = $deliveryId
         ORDER BY depth, occurred_at, recorded_at`,
      )
      .all({ $deliveryId: deliveryId }) as EventRow[]
    return rows.map(toEntry)
  }

  /** Un evento, con su scope y su payload (si se guardó): para mostrarlo o reproducirlo. */
  event(id: string): StoredEvent | undefined {
    const row = this.db.prepare('SELECT * FROM event_log WHERE id = $id').get({ $id: id }) as
      | EventRow
      | null
      | undefined
    if (!row) return undefined
    return {
      ...toEntry(row),
      ...(row.scope_json ? { scope: JSON.parse(row.scope_json) as Record<string, unknown> } : {}),
      ...(row.payload_json ? { payload: JSON.parse(row.payload_json) as unknown } : {}),
    }
  }

  /** El último evento de una task — sólo con esos resultados, si se piden. */
  lastEventForTask(taskRef: string, opts: { outcomes?: string[] } = {}): LoggedEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM event_log WHERE task_ref = $taskRef
           AND ($outcomes IS NULL OR outcome IN (SELECT value FROM json_each($outcomes)))
         ORDER BY occurred_at DESC, recorded_at DESC LIMIT 1`,
      )
      .get({
        $taskRef: taskRef,
        $outcomes: opts.outcomes ? JSON.stringify(opts.outcomes) : null,
      }) as EventRow | null | undefined
    return row ? toEntry(row) : undefined
  }

  /** Los eventos más nuevos (desde `since`, ISO, si se pide), del más nuevo al más viejo. */
  recentEvents(opts: { since?: string; limit?: number } = {}): LoggedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM event_log WHERE ($since IS NULL OR occurred_at >= $since)
         ORDER BY occurred_at DESC, recorded_at DESC LIMIT $limit`,
      )
      .all({ $since: opts.since ?? null, $limit: opts.limit ?? 100 }) as EventRow[]
    return rows.map(toEntry)
  }

  /** La traza de una ejecución en orden, desde después de `afterSeq` (para seguirla en vivo). */
  trace(
    executionId: string,
    opts: { limit?: number; afterSeq?: number } = {},
  ): StoredTraceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_trace WHERE execution_id = $executionId AND seq > $afterSeq
         ORDER BY seq LIMIT $limit`,
      )
      .all({
        $executionId: executionId,
        $afterSeq: opts.afterSeq ?? 0,
        $limit: opts.limit ?? 2_000,
      }) as TraceRow[]
    return rows.map(toTraceEntry)
  }

  /** Las ejecuciones, de la más nueva a la más vieja — de una task y en esos estados, si se piden. */
  executions(
    opts: { taskRef?: string; statuses?: ExecutionStatus[]; limit?: number } = {},
  ): ExecutionOverview[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.key, e.pipeline_id, e.status, e.started_at, e.waited_ms, e.closed_at,
           e.close_reason, e.pause_json
         FROM executions AS e
         WHERE ${TASK_FILTER}
           AND ($statuses IS NULL OR e.status IN (SELECT value FROM json_each($statuses)))
         ORDER BY e.started_at DESC, e.id LIMIT $limit`,
      )
      .all({
        $taskRef: opts.taskRef ?? null,
        $statuses: opts.statuses ? JSON.stringify(opts.statuses) : null,
        $limit: opts.limit ?? 50,
      }) as ExecutionRow[]
    return rows.map(toExecutionEntry)
  }

  /** Los tokens de una ejecución: la suma de los `gen_ai.usage.*` de sus spans (un span por
   *  request al modelo, tanto en el provider de la API como en el del CLI). */
  usage(executionId: string): ExecutionUsageTotals {
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(json_extract(attributes_json, '$."gen_ai.usage.input_tokens"')), 0) AS input,
           COALESCE(SUM(json_extract(attributes_json, '$."gen_ai.usage.output_tokens"')), 0) AS output,
           COALESCE(SUM(json_extract(attributes_json, '$."gen_ai.usage.cache_read_input_tokens"')), 0) AS cache_read
         FROM execution_trace
         WHERE execution_id = $executionId AND kind = 'span' AND phase = 'end'`,
      )
      .get({ $executionId: executionId }) as { input: number; output: number; cache_read: number }
    return {
      inputTokens: Number(row.input),
      outputTokens: Number(row.output),
      cacheReadTokens: Number(row.cache_read),
    }
  }

  /** Cómo terminó el último agente de la ejecución (ver `AgentOutcome`), si alguno terminó. */
  agentOutcome(executionId: string): AgentOutcome | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM execution_trace
         WHERE execution_id = $executionId AND kind = 'span' AND phase = 'end'
           AND json_extract(attributes_json, '$."ia.step.kind"') = 'agent'
           AND json_extract(attributes_json, '$."ia.agent.id"') IS NOT NULL
         ORDER BY seq DESC LIMIT 1`,
      )
      .get({ $executionId: executionId }) as TraceRow | null | undefined
    if (!row) return undefined
    const attributes = JSON.parse(row.attributes_json) as Record<string, TraceValue>
    const str = (key: string) => {
      const value = attributes[key]
      return typeof value === 'string' ? value : undefined
    }
    const optional = (key: string, value: string | undefined) =>
      value === undefined ? {} : { [key]: value }
    const message = row.status === 'error' ? (row.status_message ?? 'error') : undefined
    const byAgent = message?.match(AGENT_FAILURE)
    return {
      agentId: str('ia.agent.id') as string,
      ...optional('exit', str('ia.agent.exit')),
      ...optional('outcome', str('ia.agent.outcome')),
      ...optional('summary', str('ia.agent.summary')),
      ...(row.status ? { status: row.status } : {}),
      ...(message
        ? {
            failure: byAgent
              ? { by: 'agent' as const, message: byAgent[1] as string }
              : { by: 'runtime' as const, message },
          }
        : {}),
      ...optional('errorHandledBy', str('ia.step.error_handled')),
      ...optional('interruptedBy', str('ia.agent.interrupted_by')),
      ...optional('waiting', str('ia.agent.waiting')),
      ...optional('endTime', row.end_time ?? undefined),
    }
  }

  /**
   * Borra lo anterior a `olderThan` (ISO): los eventos, la traza de las ejecuciones que ya no
   * están vivas, y las ejecuciones que cerraron antes (con lo que recibieron). Una ejecución
   * corriendo o pausada nunca se toca, por vieja que sea.
   */
  prune(olderThan: string): PruneResult {
    const changes = () =>
      Number((this.db.prepare('SELECT changes() AS n').get() as { n: number }).n)
    const cutoff = { $cutoff: olderThan }
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM event_log WHERE occurred_at < $cutoff').run(cutoff)
      const events = changes()
      this.db
        .prepare(
          `DELETE FROM execution_trace WHERE start_time < $cutoff AND execution_id NOT IN (
             SELECT id FROM executions WHERE status IN ('running', 'paused'))`,
        )
        .run(cutoff)
      const traces = changes()
      const closed = `SELECT id FROM executions
        WHERE status NOT IN ('running', 'paused') AND closed_at IS NOT NULL AND closed_at < $cutoff`
      this.db.prepare(`DELETE FROM execution_inbox WHERE execution_id IN (${closed})`).run(cutoff)
      this.db.prepare(`DELETE FROM executions WHERE id IN (${closed})`).run(cutoff)
      const executions = changes()
      this.db.exec('COMMIT')
      return { events, traces, executions }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}

function toEntry(row: EventRow): LoggedEvent {
  return {
    id: row.id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
    type: row.type,
    occurredAt: row.occurred_at,
    depth: row.depth,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    ...(row.task_ref ? { taskRef: row.task_ref } : {}),
    summary: JSON.parse(row.summary_json) as Record<string, EventSummaryValue>,
    outcome: row.outcome,
    ...(row.error ? { error: row.error } : {}),
    decisions: JSON.parse(row.decisions_json) as DispatchDecision[],
    ...(row.execution_id ? { executionId: row.execution_id } : {}),
    ...(row.trace_id ? { traceId: row.trace_id } : {}),
    recordedAt: row.recorded_at,
  }
}

function toTraceEntry(row: TraceRow): StoredTraceRecord {
  return {
    seq: row.seq,
    kind: row.kind,
    ...(row.phase ? { phase: row.phase } : {}),
    name: row.name,
    ...(row.scope ? { scope: row.scope } : {}),
    ...(row.level ? { level: row.level } : {}),
    ...(row.status ? { status: row.status } : {}),
    ...(row.status_message ? { statusMessage: row.status_message } : {}),
    startTime: row.start_time,
    ...(row.end_time ? { endTime: row.end_time } : {}),
    ...(row.duration_ms !== null ? { durationMs: row.duration_ms } : {}),
    traceId: row.trace_id,
    spanId: row.span_id,
    ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
    executionId: row.execution_id,
    origin: row.origin,
    attributes: JSON.parse(row.attributes_json) as Record<string, TraceValue>,
  }
}

function toExecutionEntry(row: ExecutionRow): ExecutionOverview {
  const task = taskOfKey(row.key)
  return {
    id: row.id,
    key: row.key,
    pipelineId: row.pipeline_id,
    status: row.status,
    startedAt: row.started_at,
    waitedMs: row.waited_ms,
    ...(row.closed_at ? { closedAt: row.closed_at } : {}),
    ...(row.close_reason ? { closeReason: row.close_reason } : {}),
    ...(row.pause_json ? { pause: JSON.parse(row.pause_json) as PauseJSON } : {}),
    ...task,
  }
}

/** `issue` y `projectId` de la `key` de una ejecución (la de `scopeExecutionKey`: JSON de pares).
 *  Una key de otra forma no dice de qué task es. */
function taskOfKey(key: string): { taskRef?: string; projectId?: string } {
  let pairs: unknown
  try {
    pairs = JSON.parse(key)
  } catch {
    return {}
  }
  if (!Array.isArray(pairs)) return {}
  const out: { taskRef?: string; projectId?: string } = {}
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue
    const [name, value] = pair as [unknown, unknown]
    if (typeof value !== 'string' && typeof value !== 'number') continue
    if (name === 'issue') out.taskRef = String(value)
    if (name === 'projectId') out.projectId = String(value)
  }
  return out
}
