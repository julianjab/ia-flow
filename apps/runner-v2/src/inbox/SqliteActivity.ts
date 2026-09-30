/**
 * `ActivityPort` sobre la base de ejecuciones: lo que `SqliteActivityReader` guarda (en camelCase,
 * con los tipos del engine) llevado a la forma del wire (`@ia-flow/shared`). Una ejecución se
 * completa con cómo terminó su agente y cuántos tokens gastó, leídos de su traza.
 */
import type {
  ExecutionOverview,
  LoggedEvent,
  SqliteActivityReader,
  StoredTraceRecord,
} from '@ia-flow/agent-engine-datasource-sqlite'
import type { EventLogEntry, ExecutionSummary, TraceEntry } from '@ia-flow/shared'
import type { ActivityPort, StoredEvent } from './ActivityPort.js'

/** Los eventos que el engine despachó a algo (lo que tiene sentido volver a despachar). */
const DISPATCHED = new Set(['dispatched', 'injected', 'resumed'])

function toEntry(event: LoggedEvent): EventLogEntry {
  return {
    id: event.id,
    ...(event.parentId ? { parent_id: event.parentId } : {}),
    ...(event.deliveryId ? { delivery_id: event.deliveryId } : {}),
    type: event.type,
    occurred_at: event.occurredAt,
    depth: event.depth,
    ...(event.projectId ? { project_id: event.projectId } : {}),
    ...(event.taskRef ? { task_ref: event.taskRef } : {}),
    summary: event.summary,
    outcome: event.outcome,
    ...(event.error ? { error: event.error } : {}),
    decisions: event.decisions.map((decision) => ({
      pipeline_id: decision.pipelineId,
      source_id: decision.sourceId,
      verdict: decision.verdict,
      ...(decision.reason ? { reason: decision.reason } : {}),
    })),
    ...(event.executionId ? { execution_id: event.executionId } : {}),
    ...(event.traceId ? { trace_id: event.traceId } : {}),
  }
}

export function toTraceEntry(record: Omit<StoredTraceRecord, 'seq'>): TraceEntry {
  return {
    kind: record.kind,
    ...(record.phase ? { phase: record.phase } : {}),
    name: record.name,
    ...(record.scope ? { scope: record.scope } : {}),
    ...(record.level ? { level: record.level } : {}),
    ...(record.status ? { status: record.status } : {}),
    ...(record.statusMessage ? { status_message: record.statusMessage } : {}),
    start_time: record.startTime,
    ...(record.endTime ? { end_time: record.endTime } : {}),
    ...(record.durationMs !== undefined ? { duration_ms: record.durationMs } : {}),
    trace_id: record.traceId,
    span_id: record.spanId,
    ...(record.parentSpanId ? { parent_span_id: record.parentSpanId } : {}),
    execution_id: record.executionId,
    origin: record.origin,
    attributes: record.attributes,
  }
}

export class SqliteActivity implements ActivityPort {
  constructor(private readonly reader: SqliteActivityReader) {}

  private summary(
    row: ExecutionOverview,
  ): ExecutionSummary & { key: string; task_ref?: string; project_id?: string } {
    const outcome = this.reader.agentOutcome(row.id)
    const usage = this.reader.usage(row.id)
    const failure =
      outcome?.failure ??
      (row.status === 'failed'
        ? { by: 'runtime' as const, message: row.closeReason ?? 'la corrida falló' }
        : undefined)
    const hasUsage = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens > 0
    return {
      id: row.id,
      key: row.key,
      pipeline_id: row.pipelineId,
      status: row.status,
      started_at: row.startedAt,
      ...(row.closedAt ? { closed_at: row.closedAt } : {}),
      ...(row.closeReason ? { close_reason: row.closeReason } : {}),
      ...(outcome?.agentId ? { agent_id: outcome.agentId } : {}),
      ...(outcome?.exit ? { exit: outcome.exit } : {}),
      ...(failure ? { failure } : {}),
      ...(row.status === 'paused' && row.pause
        ? {
            pause: {
              pause_id: row.pause.pauseId,
              ...(row.pause.expiresAt
                ? { expires_at: new Date(row.pause.expiresAt).toISOString() }
                : {}),
            },
          }
        : {}),
      ...(hasUsage
        ? {
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cache_read_tokens: usage.cacheReadTokens,
            },
          }
        : {}),
      ...(row.taskRef ? { task_ref: row.taskRef } : {}),
      ...(row.projectId ? { project_id: row.projectId } : {}),
    }
  }

  executions(query: Parameters<ActivityPort['executions']>[0]) {
    return this.reader.executions(query).map((row) => this.summary(row))
  }

  lastEventAt(taskRef: string): string | undefined {
    return this.reader.eventsForTask(taskRef, 1).at(0)?.occurredAt
  }

  eventsForTask(taskRef: string, limit: number): EventLogEntry[] {
    return this.reader.eventsForTask(taskRef, limit).map(toEntry)
  }

  /** Los eventos crudos que entraron por una entrada (`github.`, `slack.`), del más nuevo. */
  ingressEvents(typePrefix: string, limit: number): EventLogEntry[] {
    return this.reader.recentEvents({ typePrefix, limit }).map(toEntry)
  }

  /** Cuántos eventos entraron por una entrada desde `since` (ISO), y el último. */
  ingressCount(typePrefix: string, since?: string): { count: number; lastAt?: string } {
    return this.reader.countEvents({ typePrefix, ...(since ? { since } : {}) })
  }

  recentEvents(limit: number, projectId?: string): EventLogEntry[] {
    const events = this.reader.recentEvents({ limit: projectId ? limit * 4 : limit })
    return events
      .filter((event) => !projectId || event.projectId === projectId)
      .slice(0, limit)
      .map(toEntry)
  }

  trace(executionId: string, limit: number): TraceEntry[] {
    const all = this.reader.trace(executionId)
    return all.slice(-limit).map(toTraceEntry)
  }

  /** El último evento de dominio (el que armó el intake, con su payload) que el engine despachó. */
  lastDispatchedEvent(taskRef: string): StoredEvent | undefined {
    const candidate = this.reader
      .eventsForTask(taskRef, 50)
      .find((event) => DISPATCHED.has(event.outcome) && event.depth > 0)
    const stored = candidate ? this.reader.event(candidate.id) : undefined
    if (!stored || stored.payload === undefined) return undefined
    return {
      id: stored.id,
      type: stored.type,
      payload: stored.payload,
      ...(stored.scope ? { scope: stored.scope } : {}),
    }
  }
}
