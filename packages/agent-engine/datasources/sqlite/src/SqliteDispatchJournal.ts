import type {
  DispatchDecision,
  DispatchJournal,
  DispatchRecord,
  DomainEvent,
} from '@ia-flow/agent-engine'
import { migrate } from './migrations.js'
import type { SqliteDatabase, SqliteStatement } from './SqliteDatabase.js'

/** Un valor del resumen de un evento: lo que se lee de un vistazo en una lista. */
export type EventSummaryValue = string | number | boolean

/** Lo que el log de eventos dice que pasó con un evento: lo del engine, más `ignored` (lo descartó
 *  la app antes de despacharlo). */
export type EventLogOutcome = DispatchRecord['outcome'] | 'ignored'

/** Un evento que la app descarta antes del engine (ej. un webhook de un repo que no escucha). */
export interface IgnoredEvent {
  event: DomainEvent<any>
  /** Por qué: queda en el resumen, como `ignored_reason`. */
  reason?: string
}

export interface SqliteDispatchJournalOptions {
  /** La base ya abierta; se le aplica el esquema. Puede ser la misma del store. */
  database: SqliteDatabase
  /** Lo que se lee de un evento en una lista (ej. `{ action, sender }`). Default: nada. */
  summarize?: (event: DomainEvent<any>) => Record<string, EventSummaryValue>
  /** Si se guarda el payload entero (para reproducir el evento). Default: sólo los derivados
   *  (`depth > 0`) — el payload de un webhook es grande y GitHub lo guarda. */
  keepPayload?: (event: DomainEvent<any>) => boolean
  /** El trace id activo al anotar (el del span `event <type>`), para ir a la traza en OTLP. */
  traceId?: () => string | undefined
}

/**
 * `event_log` en SQLite: cada evento que llega al runner y qué se decidió con él — el
 * `DispatchJournal` del `Engine` más los que la app ignora antes (`append`). Una fila por evento
 * (`id`): uno que vuelve a despacharse con el mismo id (un re-despacho, un replay) la pisa con lo
 * último que se decidió.
 *
 * `task_ref` / `project_id` / `delivery_id` salen del `scope` del evento (`issue`, `projectId`,
 * `deliveryId`): son por lo que se lo busca después (`SqliteActivityReader`).
 */
export class SqliteDispatchJournal implements DispatchJournal {
  private readonly insert: SqliteStatement
  private readonly summarize: (event: DomainEvent<any>) => Record<string, EventSummaryValue>
  private readonly keepPayload: (event: DomainEvent<any>) => boolean
  private readonly traceId: () => string | undefined

  constructor(options: SqliteDispatchJournalOptions) {
    migrate(options.database)
    this.summarize = options.summarize ?? (() => ({}))
    this.keepPayload = options.keepPayload ?? ((event) => event.depth > 0)
    this.traceId = options.traceId ?? (() => undefined)
    this.insert = options.database.prepare(
      `INSERT INTO event_log (id, parent_id, delivery_id, type, occurred_at, depth, project_id,
         task_ref, summary_json, scope_json, payload_json, outcome, error, decisions_json,
         execution_id, trace_id, recorded_at)
       VALUES ($id, $parentId, $deliveryId, $type, $occurredAt, $depth, $projectId, $taskRef,
         $summary, $scope, $payload, $outcome, $error, $decisions, $executionId, $traceId,
         $recordedAt)
       ON CONFLICT (id) DO UPDATE SET
         outcome = excluded.outcome,
         error = excluded.error,
         decisions_json = excluded.decisions_json,
         execution_id = COALESCE(excluded.execution_id, event_log.execution_id),
         trace_id = COALESCE(excluded.trace_id, event_log.trace_id),
         payload_json = COALESCE(excluded.payload_json, event_log.payload_json),
         recorded_at = excluded.recorded_at`,
    )
  }

  record(entry: DispatchRecord): void {
    this.write(entry.event, entry.outcome, entry.decisions, entry.error, entry.executionId)
  }

  /** Un evento que la app descartó antes de despacharlo: `ignored`, sin decisiones. */
  append({ event, reason }: IgnoredEvent): void {
    this.write(event, 'ignored', [], undefined, undefined, reason)
  }

  private write(
    event: DomainEvent<any>,
    outcome: EventLogOutcome,
    decisions: DispatchDecision[],
    error: string | undefined,
    executionId: string | undefined,
    ignoredReason?: string,
  ): void {
    const scope = event.scope ?? {}
    const summary = {
      ...this.summarize(event),
      ...(ignoredReason ? { ignored_reason: ignoredReason } : {}),
    }
    this.insert.run({
      $id: event.id,
      $parentId: event.parentId ?? null,
      $deliveryId: text(scope.deliveryId),
      $type: event.type,
      $occurredAt: event.occurredAt,
      $depth: event.depth,
      $projectId: text(scope.projectId),
      $taskRef: text(scope.issue),
      $summary: JSON.stringify(summary),
      $scope: event.scope ? JSON.stringify(event.scope) : null,
      $payload: this.keepPayload(event) ? (JSON.stringify(event.payload) ?? null) : null,
      $outcome: outcome,
      $error: error ?? null,
      $decisions: JSON.stringify(decisions),
      $executionId: executionId ?? null,
      $traceId: this.traceId() ?? null,
      $recordedAt: new Date().toISOString(),
    })
  }
}

/** Un valor del scope como texto (un `issue` puede venir como número). */
function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}
