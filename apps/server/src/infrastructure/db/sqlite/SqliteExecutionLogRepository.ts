import type { Database } from 'bun:sqlite'
import type {
  AgentDetail,
  AgentHealth,
  ExecutionLog,
  ExecutionLogFilters,
  ExecutionStats,
  ExecutionStatsFilters,
  TaskRunSummary,
} from '@ia-flow/shared'
import { estimateCostUsd } from '@ia-flow/shared'
import type { IExecutionLogRepository } from '../../../domain/ports/IExecutionLogRepository.js'
import type { IExecutionStatsRepository } from '../../../domain/ports/IExecutionStatsRepository.js'
import { createLogger } from '../../../logger.js'

const log = createLogger('execution-log-repo')

function rowToLog(r: Record<string, unknown>): ExecutionLog {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    taskId: r.task_id as string,
    taskTitle: r.task_title as string,
    agentId: r.agent_id as string,
    providerId: r.provider_id as string,
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? null,
    outcome: (r.outcome as ExecutionLog['outcome']) ?? null,
    errorMsg: (r.error_msg as string | null) ?? null,
    stopReason: (r.stop_reason as string | null) ?? null,
    sessionKind: (r.session_kind as ExecutionLog['sessionKind']) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    cancelRequestedAt: (r.cancel_requested_at as string | null) ?? null,
    durationMs: (r.duration_ms as number | null) ?? null,
    tokensIn: (r.tokens_in as number | null) ?? null,
    tokensOut: (r.tokens_out as number | null) ?? null,
    cacheReadTokens: (r.cache_read_tokens as number | null) ?? null,
    cacheCreationTokens: (r.cache_creation_tokens as number | null) ?? null,
    iters: (r.iters as number | null) ?? null,
    toolCalls: (r.tool_calls as number | null) ?? null,
    toolErrors: (r.tool_errors as number | null) ?? null,
    failureClass: (r.failure_class as ExecutionLog['failureClass']) ?? null,
    runId: (r.run_id as string | null) ?? null,
    agentPromptHash: (r.agent_prompt_hash as string | null) ?? null,
    systemPromptHash: (r.system_prompt_hash as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    toolBreakdown: r.tool_breakdown
      ? (JSON.parse(r.tool_breakdown as string) as ExecutionLog['toolBreakdown'])
      : null,
    initialStatus: (r.initial_status as string | null) ?? null,
    exits: r.exits ? (JSON.parse(r.exits as string) as Record<string, string>) : null,
    assignees: r.assignees ? (JSON.parse(r.assignees as string) as string[]) : null,
    finalizedByTool: r.finalized_by_tool == null ? null : r.finalized_by_tool === 1,
    // `?? 'agent'` y no el default de la columna: una fila que llegó
    // reenviada por RemoteExecutionLogRepository desde un daemon anterior a la
    // migración 065 no trae el campo, y para la UI es un run de agente.
    kind: (r.kind as string | null) ?? 'agent',
    ruleId: (r.rule_id as string | null) ?? null,
    eventId: (r.event_id as string | null) ?? null,
    eventType: (r.event_type as string | null) ?? null,
    position: (r.position as number | null) ?? null,
    parentId: (r.parent_id as string | null) ?? null,
    resumedFromRunId: (r.resumed_from_run_id as string | null) ?? null,
    traceId: (r.trace_id as string | null) ?? null,
    // Ausente cuando la fila viene de list() (proyección sin esta columna a
    // propósito — ver el comentario del schema): `undefined` colapsa a null
    // igual que una fila que nunca la tuvo.
    structuredOutput: r.structured_output
      ? (JSON.parse(r.structured_output as string) as ExecutionLog['structuredOutput'])
      : null,
  }
}

export class SqliteExecutionLogRepository
  implements IExecutionLogRepository, IExecutionStatsRepository
{
  /**
   * `ownSource` scopes `sweepOrphaned` (see below) — pass the same value
   * given to SourceTaggingExecutionLogRepository (IA_FLOW_INSTANCE_ID) so a
   * restart only closes THIS process's own dangling rows, never rows
   * forwarded in from another container's RemoteExecutionLogRepository.
   */
  constructor(
    private db: Database,
    private ownSource: string | null = null,
  ) {}

  // Upsert: a retried/duplicate forward from RemoteExecutionLogRepository
  // (network blip, container restart) must overwrite the existing row
  // instead of throwing SQLITE_CONSTRAINT on the id PK.
  //
  // cancel_requested_at is the one column excluded from that overwrite
  // (COALESCE keeps the existing value when excluded.* is null): the
  // headless container that owns a forwarded row never learns an operator
  // marked it cancel-requested on the main daemon (see routes/executions.ts)
  // — RemoteExecutionLogRepository.update() re-sends its own last-known copy
  // of the row as a self-healing upsert, which would otherwise null out the
  // marker the moment the container's next progress/finish update arrives.
  insert(entry: ExecutionLog): void {
    this.db.run(
      `INSERT INTO execution_logs
        (id, project_id, task_id, task_title, agent_id, provider_id, started_at, finished_at, outcome, error_msg, stop_reason, session_kind, session_id, source, cancel_requested_at,
         duration_ms, tokens_in, tokens_out, cache_read_tokens, cache_creation_tokens, iters, tool_calls, tool_errors, failure_class, run_id, agent_prompt_hash,
         initial_status, exits, finalized_by_tool, assignees,
         kind, rule_id, event_id, event_type, position, parent_id,
         model, system_prompt_hash, tool_breakdown, resumed_from_run_id, trace_id, structured_output)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         task_id = excluded.task_id,
         task_title = excluded.task_title,
         agent_id = excluded.agent_id,
         provider_id = excluded.provider_id,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         outcome = excluded.outcome,
         error_msg = excluded.error_msg,
         stop_reason = excluded.stop_reason,
         session_kind = excluded.session_kind,
         session_id = excluded.session_id,
         source = excluded.source,
         cancel_requested_at = COALESCE(excluded.cancel_requested_at, execution_logs.cancel_requested_at),
         duration_ms = excluded.duration_ms,
         tokens_in = excluded.tokens_in,
         tokens_out = excluded.tokens_out,
         cache_read_tokens = excluded.cache_read_tokens,
         cache_creation_tokens = excluded.cache_creation_tokens,
         iters = excluded.iters,
         tool_calls = excluded.tool_calls,
         tool_errors = excluded.tool_errors,
         failure_class = excluded.failure_class,
         run_id = excluded.run_id,
         agent_prompt_hash = excluded.agent_prompt_hash,
         initial_status = excluded.initial_status,
         exits = excluded.exits,
         finalized_by_tool = COALESCE(excluded.finalized_by_tool, execution_logs.finalized_by_tool),
         assignees = excluded.assignees,
         kind = excluded.kind,
         rule_id = excluded.rule_id,
         event_id = excluded.event_id,
         event_type = excluded.event_type,
         position = excluded.position,
         parent_id = excluded.parent_id,
         model = excluded.model,
         system_prompt_hash = excluded.system_prompt_hash,
         tool_breakdown = excluded.tool_breakdown,
         resumed_from_run_id = excluded.resumed_from_run_id,
         trace_id = excluded.trace_id,
         structured_output = excluded.structured_output`,
      [
        entry.id,
        entry.projectId,
        entry.taskId,
        entry.taskTitle,
        entry.agentId,
        entry.providerId,
        entry.startedAt,
        entry.finishedAt,
        entry.outcome,
        entry.errorMsg,
        entry.stopReason,
        entry.sessionKind ?? null,
        entry.sessionId ?? null,
        entry.source ?? null,
        entry.cancelRequestedAt ?? null,
        entry.durationMs ?? null,
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.cacheReadTokens ?? null,
        entry.cacheCreationTokens ?? null,
        entry.iters ?? null,
        entry.toolCalls ?? null,
        entry.toolErrors ?? null,
        entry.failureClass ?? null,
        entry.runId ?? null,
        entry.agentPromptHash ?? null,
        entry.initialStatus ?? null,
        entry.exits ? JSON.stringify(entry.exits) : null,
        entry.finalizedByTool == null ? null : entry.finalizedByTool ? 1 : 0,
        entry.assignees ? JSON.stringify(entry.assignees) : null,
        entry.kind ?? 'agent',
        entry.ruleId ?? null,
        entry.eventId ?? null,
        entry.eventType ?? null,
        entry.position ?? null,
        entry.parentId ?? null,
        entry.model ?? null,
        entry.systemPromptHash ?? null,
        entry.toolBreakdown ? JSON.stringify(entry.toolBreakdown) : null,
        entry.resumedFromRunId ?? null,
        entry.traceId ?? null,
        entry.structuredOutput ? JSON.stringify(entry.structuredOutput) : null,
      ],
    )
    log.debug({ id: entry.id }, 'Inserted execution log')
  }

  update(id: string, patch: Partial<ExecutionLog>): void {
    const colMap: Record<string, string> = {
      projectId: 'project_id',
      taskId: 'task_id',
      taskTitle: 'task_title',
      agentId: 'agent_id',
      providerId: 'provider_id',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      outcome: 'outcome',
      errorMsg: 'error_msg',
      stopReason: 'stop_reason',
      sessionKind: 'session_kind',
      sessionId: 'session_id',
      source: 'source',
      cancelRequestedAt: 'cancel_requested_at',
      durationMs: 'duration_ms',
      tokensIn: 'tokens_in',
      tokensOut: 'tokens_out',
      cacheReadTokens: 'cache_read_tokens',
      cacheCreationTokens: 'cache_creation_tokens',
      iters: 'iters',
      toolCalls: 'tool_calls',
      toolErrors: 'tool_errors',
      failureClass: 'failure_class',
      runId: 'run_id',
      agentPromptHash: 'agent_prompt_hash',
      initialStatus: 'initial_status',
      exits: 'exits',
      finalizedByTool: 'finalized_by_tool',
      assignees: 'assignees',
      kind: 'kind',
      ruleId: 'rule_id',
      eventId: 'event_id',
      eventType: 'event_type',
      position: 'position',
      parentId: 'parent_id',
      model: 'model',
      systemPromptHash: 'system_prompt_hash',
      toolBreakdown: 'tool_breakdown',
      resumedFromRunId: 'resumed_from_run_id',
      traceId: 'trace_id',
      structuredOutput: 'structured_output',
    }

    const setClauses: string[] = []
    const params: unknown[] = []

    for (const [key, col] of Object.entries(colMap)) {
      if (key in patch && key !== 'id') {
        const value = patch[key as keyof ExecutionLog] ?? null
        setClauses.push(`${col} = ?`)
        // SQLite no tiene booleanos: `finalized_by_tool` viaja como 0/1.
        if (typeof value === 'boolean') params.push(value ? 1 : 0)
        // Las columnas JSON (`exits`, `assignees`) tienen que serializarse acá
        // igual que en el insert: bun:sqlite no sabe bindear un objeto y tira
        // "can't bind". Valía para `exits` desde siempre — nadie lo patcheaba,
        // así que el agujero nunca se disparó.
        else if (value !== null && typeof value === 'object') params.push(JSON.stringify(value))
        else params.push(value)
      }
    }

    if (setClauses.length === 0) return

    params.push(id)
    this.db.run(
      `UPDATE execution_logs SET ${setClauses.join(', ')} WHERE id = ?`,
      params as string[],
    )
    log.debug({ id }, 'Updated execution log')
  }

  list(filters: ExecutionLogFilters): ExecutionLog[] {
    const whereClauses: string[] = []
    const params: unknown[] = []

    if (filters.taskId !== undefined) {
      whereClauses.push('task_id = ?')
      params.push(filters.taskId)
    }
    const inClause = (col: string, raw: string | string[] | undefined): void => {
      if (raw === undefined) return
      const arr = Array.isArray(raw) ? raw : [raw]
      const cleaned = arr.map((v) => v.trim()).filter((v) => v.length > 0)
      if (cleaned.length === 0) return
      whereClauses.push(`${col} IN (${cleaned.map(() => '?').join(', ')})`)
      params.push(...cleaned)
    }
    inClause('project_id', filters.projectId)
    inClause('agent_id', filters.agentId)
    inClause('provider_id', filters.providerId)
    inClause('outcome', filters.outcome as string | string[] | undefined)
    inClause('source', filters.source)
    inClause('failure_class', filters.failureClass as string | string[] | undefined)
    // Sin filtro entran las acciones al lado de los runs — es el listado del
    // pipeline completo. `kind: 'agent'` recupera la lista de siempre.
    inClause('kind', filters.kind)
    if (filters.eventId !== undefined) {
      whereClauses.push('event_id = ?')
      params.push(filters.eventId)
    }
    if (filters.traceId !== undefined) {
      whereClauses.push('trace_id = ?')
      params.push(filters.traceId)
    }
    inClause('rule_id', filters.ruleId)
    // `assignees` es una columna JSON, así que el `IN` va contra los elementos
    // de la lista y no contra la columna: una fila matchea si el usuario
    // buscado está ENTRE sus assignees. `json_each` sobre un NULL no devuelve
    // filas, así que las ejecuciones previas a la migración 057 simplemente no
    // matchean, sin romper la query.
    if (filters.assignee !== undefined) {
      const raw = filters.assignee
      const cleaned = (Array.isArray(raw) ? raw : [raw]).map((v) => v.trim()).filter(Boolean)
      if (cleaned.length > 0) {
        whereClauses.push(
          `EXISTS (SELECT 1 FROM json_each(execution_logs.assignees) WHERE value IN (${cleaned
            .map(() => '?')
            .join(', ')}))`,
        )
        params.push(...cleaned)
      }
    }
    if (filters.from !== undefined) {
      whereClauses.push('started_at >= ?')
      params.push(filters.from)
    }
    if (filters.to !== undefined) {
      whereClauses.push('started_at <= ?')
      params.push(filters.to)
    }

    // Proyección explícita, SIN `structured_output`: este listado es el
    // `SELECT *` que powers `GET /api/executions` — no hay motivo para que
    // cada fila del listado arrastre el JSON de salida estructurada, que sólo
    // hace falta al leer una fila puntual (getById) o al hidratar
    // `{{task.previous_outputs}}` (listLastOutputsByAgent).
    let sql = `SELECT id, project_id, task_id, task_title, agent_id, provider_id, started_at,
                      finished_at, outcome, error_msg, stop_reason, session_kind, session_id,
                      source, cancel_requested_at, duration_ms, tokens_in, tokens_out,
                      cache_read_tokens, cache_creation_tokens, iters, tool_calls, tool_errors,
                      failure_class, run_id, agent_prompt_hash, initial_status, exits,
                      finalized_by_tool, assignees, kind, rule_id, event_id, event_type, position,
                      parent_id, model, system_prompt_hash, tool_breakdown, resumed_from_run_id,
                      trace_id
                 FROM execution_logs`
    if (whereClauses.length > 0) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`
    }
    sql += ' ORDER BY started_at DESC'

    if (filters.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(filters.limit)
    }

    const rows = this.db.query(sql).all(...(params as string[])) as Record<string, unknown>[]
    return rows.map(rowToLog)
  }

  // Sólo runs de agente, aunque desde la migración 065 la tabla guarde
  // también las acciones. Los tres consumidores —el rehidratador de pending
  // tasks, el guard de divergencia y la lista de "activos" de la UI— hablan de
  // runs que se pueden reconciliar o cancelar; una acción `http` colgada no es
  // ninguna de las dos cosas, y la cierra `sweepOrphaned` como a cualquier
  // fila abierta.
  listActive(): ExecutionLog[] {
    const rows = this.db
      .query(
        `SELECT * FROM execution_logs
          WHERE finished_at IS NULL AND kind = 'agent'
          ORDER BY started_at DESC`,
      )
      .all() as Record<string, unknown>[]
    return rows.map(rowToLog)
  }

  getById(id: string): ExecutionLog | null {
    const row = this.db.query('SELECT * FROM execution_logs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? rowToLog(row) : null
  }

  sweepOrphaned(reason: string): ExecutionLog[] {
    const nowIso = new Date().toISOString()
    // COALESCE keeps whatever a concurrent writer set between our SELECT and
    // UPDATE. In practice this runs on a cold server so contention is zero,
    // but it costs nothing to be safe.
    //
    // `source IS ?` scopes the sweep to rows THIS process owns (ownSource,
    // NULL for the main daemon). Without it, a main-daemon restart would
    // also mark rows forwarded from a still-running headless container
    // (subscriptions-pipeline, etc.) as errored, even though that run is
    // alive in its own process.
    //
    // The ids are captured BEFORE the UPDATE (afterwards the rows no longer
    // match `finished_at IS NULL`) so we can hand the closed rows back:
    // CompositeExecutionLogRepository replays them onto its write-only
    // mirrors, which a bulk UPDATE against this DB alone never reaches.
    const ids = (
      this.db
        .query('SELECT id FROM execution_logs WHERE finished_at IS NULL AND source IS ?')
        .all(this.ownSource) as Array<{ id: string }>
    ).map((r) => r.id)
    if (ids.length === 0) return []

    this.db.run(
      `UPDATE execution_logs
          SET finished_at = COALESCE(finished_at, ?),
              outcome     = COALESCE(outcome, 'error'),
              error_msg   = COALESCE(error_msg, ?)
        WHERE finished_at IS NULL AND source IS ?`,
      [nowIso, reason, this.ownSource],
    )

    const placeholders = ids.map(() => '?').join(', ')
    const rows = this.db
      .query(`SELECT * FROM execution_logs WHERE id IN (${placeholders})`)
      .all(...ids) as Array<Record<string, unknown>>
    return rows.map(rowToLog)
  }

  listDistinctSources(): string[] {
    const rows = this.db
      .query('SELECT DISTINCT source FROM execution_logs WHERE source IS NOT NULL ORDER BY source')
      .all() as Array<{ source: string }>
    return rows.map((r) => r.source)
  }

  listLatestByTask(projectId: string): TaskRunSummary[] {
    // Una sola query para las dos preguntas: cuál fue el último run de cada
    // tarea, y cuántos hubo. `ORDER BY started_at DESC` + quedarse con la
    // primera aparición de cada task_id en JS —el mismo patrón que
    // `listLastOutputsByAgent`— en vez de una window function: SQLite las
    // soporta, pero acá el volumen es "los runs de un proyecto" y el dedupe en
    // memoria evita una segunda forma de leer la tabla en este archivo.
    //
    // `kind = 'agent'`: una acción de regla (notificar, script) no es un
    // intento, y contarla diría "2 intentos" sobre una tarea que corrió una
    // sola vez.
    //
    // Índice: `idx_execution_logs_project_id` acota el scan al proyecto y
    // `idx_execution_logs_task_started` sirve el orden.
    const rows = this.db
      .query(
        `SELECT id, project_id, task_id, task_title, agent_id, provider_id, started_at,
                finished_at, outcome, error_msg, stop_reason, session_kind, session_id,
                source, cancel_requested_at, duration_ms, tokens_in, tokens_out,
                cache_read_tokens, cache_creation_tokens, iters, tool_calls, tool_errors,
                failure_class, run_id, agent_prompt_hash, initial_status, exits,
                finalized_by_tool, assignees, kind, rule_id, event_id, event_type, position,
                parent_id, model, system_prompt_hash, tool_breakdown, resumed_from_run_id,
                trace_id
           FROM execution_logs
          WHERE project_id = ? AND kind = 'agent'
          ORDER BY started_at DESC`,
      )
      .all(projectId) as Record<string, unknown>[]

    const byTask = new Map<string, TaskRunSummary>()
    for (const row of rows) {
      const taskId = row.task_id as string
      const existing = byTask.get(taskId)
      // La primera aparición es la más reciente (el ORDER BY); las siguientes
      // sólo suman al conteo de intentos.
      if (existing) existing.attempts += 1
      else byTask.set(taskId, { taskId, attempts: 1, last: rowToLog(row) })
    }
    return [...byTask.values()]
  }

  listLastOutputsByAgent(
    taskId: string,
  ): Array<{ agentId: string; structuredOutput: Record<string, unknown> }> {
    // `ORDER BY started_at DESC` + quedarse con la primera aparición de cada
    // agent_id en JS: más simple que una window function para lo que es un
    // puñado de filas por task, y el resto del repo ya resuelve dedupes así.
    const rows = this.db
      .query(
        `SELECT agent_id, structured_output FROM execution_logs
          WHERE task_id = ? AND kind = 'agent' AND structured_output IS NOT NULL
          ORDER BY started_at DESC`,
      )
      .all(taskId) as Array<{ agent_id: string; structured_output: string }>

    const seen = new Set<string>()
    const out: Array<{ agentId: string; structuredOutput: Record<string, unknown> }> = []
    for (const row of rows) {
      if (seen.has(row.agent_id)) continue
      seen.add(row.agent_id)
      try {
        out.push({ agentId: row.agent_id, structuredOutput: JSON.parse(row.structured_output) })
      } catch (err) {
        log.warn({ err, taskId, agentId: row.agent_id }, 'structured_output ilegible — se saltea')
      }
    }
    return out
  }

  // Aggregates in SQL, not in the caller: the useful windows (a month of
  // runs) are far bigger than any page the UI fetches, and a success rate
  // computed off the last N rows silently lies about the rest.
  //
  // Only FINISHED runs count — an in-flight row has no outcome yet, and
  // including it would drag every rate down while an agent is mid-run.
  // Shared by stats() and agentDetail() so a filter can't mean two different
  // things depending on which one you asked — the detail view has to be a
  // decomposition of the exact rows the panel counted, or the numbers stop
  // adding up between the two.
  private statsWhere(filters: ExecutionStatsFilters): { where: string; params: unknown[] } {
    // `kind = 'agent'` no es un filtro más: la salud de un agente es sobre sus
    // RUNS. Desde la migración 065 la tabla también guarda las acciones que
    // corrió una regla, y contarlas acá diluiría el success rate de cada
    // agente con notificaciones y llamadas HTTP que no son suyas.
    const whereClauses: string[] = ['finished_at IS NOT NULL', "kind = 'agent'"]
    const params: unknown[] = []

    const inClause = (col: string, raw: string | string[] | undefined): void => {
      if (raw === undefined) return
      const arr = Array.isArray(raw) ? raw : [raw]
      const cleaned = arr.map((v) => v.trim()).filter((v) => v.length > 0)
      if (cleaned.length === 0) return
      whereClauses.push(`${col} IN (${cleaned.map(() => '?').join(', ')})`)
      params.push(...cleaned)
    }
    inClause('project_id', filters.projectId)
    inClause('agent_id', filters.agentId)
    inClause('source', filters.source)
    if (filters.from !== undefined) {
      whereClauses.push('started_at >= ?')
      params.push(filters.from)
    }
    if (filters.to !== undefined) {
      whereClauses.push('started_at <= ?')
      params.push(filters.to)
    }
    return { where: `WHERE ${whereClauses.join(' AND ')}`, params }
  }

  stats(filters: ExecutionStatsFilters): ExecutionStats {
    const { where, params } = this.statsWhere(filters)

    // COALESCE on the token/tool sums so an agent whose runs all predate
    // migration 045 reports 0 rather than null — "no data" and "zero" read
    // the same in a total, and null would break the arithmetic downstream.
    const rows = this.db
      .query(`SELECT
                agent_id                                              AS agentId,
                COUNT(*)                                              AS runs,
                SUM(CASE WHEN outcome = 'success'   THEN 1 ELSE 0 END) AS success,
                SUM(CASE WHEN outcome = 'error'     THEN 1 ELSE 0 END) AS error,
                SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
                SUM(CASE WHEN outcome = 'truncated' THEN 1 ELSE 0 END) AS truncated,
                AVG(duration_ms)                                      AS avgDurationMs,
                COALESCE(SUM(tokens_in), 0)                           AS tokensIn,
                COALESCE(SUM(tokens_out), 0)                          AS tokensOut,
                COALESCE(SUM(cache_read_tokens), 0)                   AS cacheReadTokens,
                COALESCE(SUM(cache_creation_tokens), 0)               AS cacheCreationTokens,
                COALESCE(SUM(iters), 0)                               AS iters,
                COALESCE(SUM(tool_calls), 0)                          AS toolCalls,
                COALESCE(SUM(tool_errors), 0)                         AS toolErrors,
                MAX(started_at)                                       AS lastRunAt,
                COUNT(DISTINCT agent_prompt_hash)                     AS promptVersions,
                COUNT(DISTINCT system_prompt_hash)                    AS systemPromptVersions
              FROM execution_logs ${where}
              GROUP BY agent_id
              ORDER BY runs DESC`)
      .all(...(params as string[])) as Array<Record<string, unknown>>

    // Costo: los tokens se suman POR MODELO y recién ahí se les pone precio,
    // porque un agente que cambió de modelo en la ventana (o elige entre dos
    // providers con `whenText`) mezcla tarifas. El precio no se persiste —
    // sale de la tabla de `@ia-flow/shared` al leer, así un cambio de tarifa
    // no obliga a reescribir filas.
    const costByAgent = this.costByGroup('agent_id', where, params)

    // Desglose por tool, sumando el JSON de cada fila con json_each. Es lo que
    // le da sentido a `toolCalls`: 68 llamadas no dicen nada, 50 fs_read sí.
    const toolsByAgent = this.toolBreakdownByGroup('agent_id', where, params)

    const classRows = this.db
      .query(`SELECT agent_id AS agentId, failure_class AS failureClass, COUNT(*) AS n
              FROM execution_logs ${where} AND failure_class IS NOT NULL
              GROUP BY agent_id, failure_class`)
      .all(...(params as string[])) as Array<{
      agentId: string
      failureClass: string
      n: number
    }>

    const byAgent = new Map<string, Record<string, number>>()
    for (const row of classRows) {
      const bucket = byAgent.get(row.agentId) ?? {}
      bucket[row.failureClass] = row.n
      byAgent.set(row.agentId, bucket)
    }

    // Misma forma que `classRows`, sobre stop_reason: por qué la API cortó la
    // generación. `max_tokens` es el que importa — dice que el run se quedó sin
    // presupuesto, algo que el contador `truncated` registra sin explicar.
    const stopRows = this.db
      .query(`SELECT agent_id AS agentId, stop_reason AS stopReason, COUNT(*) AS n
              FROM execution_logs ${where} AND stop_reason IS NOT NULL
              GROUP BY agent_id, stop_reason`)
      .all(...(params as string[])) as Array<{
      agentId: string
      stopReason: string
      n: number
    }>

    const stopsByAgent = new Map<string, Record<string, number>>()
    for (const row of stopRows) {
      const bucket = stopsByAgent.get(row.agentId) ?? {}
      bucket[row.stopReason] = row.n
      stopsByAgent.set(row.agentId, bucket)
    }

    // p95 de duración. SQLite no trae percentiles, así que se rankea cada run
    // dentro de su agente con una window function y se toma el más rápido de
    // los que caen en el 5% superior. `MIN` (y no `MAX`) porque el borde del
    // percentil es el primero que entra, no el peor run entero.
    const p95Rows = this.db
      .query(`SELECT agentId, MIN(duration_ms) AS p95
              FROM (
                SELECT agent_id AS agentId,
                       duration_ms,
                       PERCENT_RANK() OVER (
                         PARTITION BY agent_id ORDER BY duration_ms
                       ) AS pr
                FROM execution_logs ${where} AND duration_ms IS NOT NULL
              )
              WHERE pr >= 0.95
              GROUP BY agentId`)
      .all(...(params as string[])) as Array<{ agentId: string; p95: number | null }>

    const p95ByAgent = new Map<string, number | null>(
      p95Rows.map((r) => [r.agentId, r.p95 === null ? null : Math.round(Number(r.p95))]),
    )

    // cacheRead / (cacheRead + fresh). Null cuando no hay entrada observable:
    // un roster de puros runs de terminal no reporta tokens, y un 0% ahí
    // señalaría un problema de caching que no existe.
    const hitRate = (cacheRead: number, fresh: number): number | null => {
      const total = cacheRead + fresh
      return total > 0 ? cacheRead / total : null
    }

    const rate = (success: number, runs: number): number | null =>
      runs > 0 ? success / runs : null

    const agents: AgentHealth[] = rows.map((r) => {
      const runs = Number(r.runs ?? 0)
      const success = Number(r.success ?? 0)
      const tokensIn = Number(r.tokensIn ?? 0)
      const cacheReadTokens = Number(r.cacheReadTokens ?? 0)
      return {
        agentId: r.agentId as string,
        runs,
        success,
        error: Number(r.error ?? 0),
        cancelled: Number(r.cancelled ?? 0),
        truncated: Number(r.truncated ?? 0),
        successRate: rate(success, runs),
        failureClasses: byAgent.get(r.agentId as string) ?? {},
        avgDurationMs: r.avgDurationMs === null ? null : Math.round(Number(r.avgDurationMs)),
        p95DurationMs: p95ByAgent.get(r.agentId as string) ?? null,
        tokensIn,
        tokensOut: Number(r.tokensOut ?? 0),
        cacheReadTokens,
        cacheCreationTokens: Number(r.cacheCreationTokens ?? 0),
        cacheHitRate: hitRate(cacheReadTokens, tokensIn),
        iters: Number(r.iters ?? 0),
        toolCalls: Number(r.toolCalls ?? 0),
        toolErrors: Number(r.toolErrors ?? 0),
        stopReasons: stopsByAgent.get(r.agentId as string) ?? {},
        lastRunAt: (r.lastRunAt as string | null) ?? null,
        promptVersions: Number(r.promptVersions ?? 0),
        systemPromptVersions: Number(r.systemPromptVersions ?? 0),
        costUsd: costByAgent.get(r.agentId as string)?.costUsd ?? null,
        models: costByAgent.get(r.agentId as string)?.models ?? {},
        toolBreakdown: toolsByAgent.get(r.agentId as string) ?? {},
      }
    })

    const sum = (pick: (a: AgentHealth) => number): number =>
      agents.reduce((acc, a) => acc + pick(a), 0)
    const totalRuns = sum((a) => a.runs)
    const totalSuccess = sum((a) => a.success)
    const failureClasses: Record<string, number> = {}
    const stopReasons: Record<string, number> = {}
    for (const agent of agents) {
      for (const [cls, n] of Object.entries(agent.failureClasses)) {
        failureClasses[cls] = (failureClasses[cls] ?? 0) + n
      }
      for (const [reason, n] of Object.entries(agent.stopReasons)) {
        stopReasons[reason] = (stopReasons[reason] ?? 0) + n
      }
    }
    const totalTokensIn = sum((a) => a.tokensIn)
    const totalCacheRead = sum((a) => a.cacheReadTokens)
    // Null si NINGÚN agente pudo estimarse; si alguno sí, la suma de los que
    // pudieron — un total parcial marcado como estimación vale más que nada.
    const priced = agents.filter((a) => a.costUsd !== null)
    const totalCost =
      priced.length > 0 ? priced.reduce((acc, a) => acc + (a.costUsd ?? 0), 0) : null

    return {
      from: filters.from ?? null,
      to: filters.to ?? null,
      totals: {
        runs: totalRuns,
        success: totalSuccess,
        error: sum((a) => a.error),
        cancelled: sum((a) => a.cancelled),
        truncated: sum((a) => a.truncated),
        successRate: rate(totalSuccess, totalRuns),
        failureClasses,
        stopReasons,
        tokensIn: totalTokensIn,
        tokensOut: sum((a) => a.tokensOut),
        cacheReadTokens: totalCacheRead,
        cacheCreationTokens: sum((a) => a.cacheCreationTokens),
        // Se recalcula sobre los totales en vez de promediar los ratios por
        // agente: un agente con 3 runs pesaría igual que uno con 300.
        cacheHitRate: hitRate(totalCacheRead, totalTokensIn),
        iters: sum((a) => a.iters),
        costUsd: totalCost,
      },
      agents,
    }
  }

  /**
   * Costo estimado y runs por modelo, agrupado por una columna (`agent_id`
   * para el panel, un hash de versión para el detalle). Los runs sin modelo
   * no entran: no tienen precio, y contarlos como 0 los haría parecer
   * gratis. `costUsd` es null cuando ningún run del grupo pudo tasarse.
   */
  private costByGroup(
    groupCol: 'agent_id' | 'agent_prompt_hash' | 'system_prompt_hash',
    where: string,
    params: unknown[],
  ): Map<string | null, { costUsd: number | null; models: Record<string, number> }> {
    const rows = this.db
      .query(`SELECT ${groupCol}                              AS grp,
                     model                                    AS model,
                     COUNT(*)                                 AS runs,
                     COALESCE(SUM(tokens_in), 0)              AS tokensIn,
                     COALESCE(SUM(tokens_out), 0)             AS tokensOut,
                     COALESCE(SUM(cache_read_tokens), 0)      AS cacheReadTokens,
                     COALESCE(SUM(cache_creation_tokens), 0)  AS cacheCreationTokens
                FROM execution_logs ${where} AND model IS NOT NULL
               GROUP BY ${groupCol}, model`)
      .all(...(params as string[])) as Array<Record<string, unknown>>

    const out = new Map<string | null, { costUsd: number | null; models: Record<string, number> }>()
    for (const r of rows) {
      const grp = (r.grp as string | null) ?? null
      const model = r.model as string
      const bucket = out.get(grp) ?? { costUsd: null, models: {} }
      bucket.models[model] = Number(r.runs ?? 0)
      const cost = estimateCostUsd(model, {
        tokensIn: Number(r.tokensIn ?? 0),
        tokensOut: Number(r.tokensOut ?? 0),
        cacheReadTokens: Number(r.cacheReadTokens ?? 0),
        cacheCreationTokens: Number(r.cacheCreationTokens ?? 0),
      })
      if (cost !== null) bucket.costUsd = (bucket.costUsd ?? 0) + cost
      out.set(grp, bucket)
    }
    return out
  }

  /** Llamadas y errores por tool, sumados por grupo, desde el JSON de cada fila. */
  private toolBreakdownByGroup(
    groupCol: 'agent_id',
    where: string,
    params: unknown[],
  ): Map<string, Record<string, { calls: number; errors: number }>> {
    const rows = this.db
      .query(`SELECT execution_logs.${groupCol}                                AS grp,
                     json_each.key                                             AS tool,
                     COALESCE(SUM(json_extract(json_each.value, '$.calls')), 0)  AS calls,
                     COALESCE(SUM(json_extract(json_each.value, '$.errors')), 0) AS errors
                FROM execution_logs, json_each(execution_logs.tool_breakdown)
                ${where} AND tool_breakdown IS NOT NULL
               GROUP BY execution_logs.${groupCol}, json_each.key`)
      .all(...(params as string[])) as Array<Record<string, unknown>>

    const out = new Map<string, Record<string, { calls: number; errors: number }>>()
    for (const r of rows) {
      const grp = r.grp as string
      const bucket = out.get(grp) ?? {}
      bucket[r.tool as string] = { calls: Number(r.calls ?? 0), errors: Number(r.errors ?? 0) }
      out.set(grp, bucket)
    }
    return out
  }

  /**
   * Runs, tasa y costo por versión (de config del agente o de system prompt).
   * Es el corte que hace atribuible una regresión: mismo agente, otro hash,
   * otra tasa — u otro costo por run, que la tasa sola no ve.
   */
  private versionStats(
    hashCol: 'agent_prompt_hash' | 'system_prompt_hash',
    where: string,
    params: unknown[],
  ): Array<{
    hash: string | null
    runs: number
    success: number
    successRate: number | null
    firstSeen: string
    lastSeen: string
    iters: number
    tokensIn: number
    cacheHitRate: number | null
    costUsd: number | null
  }> {
    // El hash es NULL para todo run anterior a que existiera la columna;
    // ésos caen en un solo bucket "sin versión" en vez de desaparecer —
    // esconderlos haría que la historia del agente empezara el día que
    // se agregó la columna.
    const rows = this.db
      .query(`SELECT ${hashCol}                                            AS hash,
                     COUNT(*)                                              AS runs,
                     SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END)  AS success,
                     MIN(started_at)                                       AS firstSeen,
                     MAX(started_at)                                       AS lastSeen,
                     COALESCE(SUM(iters), 0)                               AS iters,
                     COALESCE(SUM(tokens_in), 0)                           AS tokensIn,
                     COALESCE(SUM(cache_read_tokens), 0)                   AS cacheReadTokens
                FROM execution_logs ${where}
               GROUP BY ${hashCol}
               ORDER BY lastSeen DESC`)
      .all(...(params as string[])) as Array<Record<string, unknown>>
    const cost = this.costByGroup(hashCol, where, params)

    return rows.map((r) => {
      const runs = Number(r.runs ?? 0)
      const success = Number(r.success ?? 0)
      const tokensIn = Number(r.tokensIn ?? 0)
      const cacheRead = Number(r.cacheReadTokens ?? 0)
      const hash = (r.hash as string | null) ?? null
      return {
        hash,
        runs,
        success,
        successRate: runs > 0 ? success / runs : null,
        firstSeen: r.firstSeen as string,
        lastSeen: r.lastSeen as string,
        iters: Number(r.iters ?? 0),
        tokensIn,
        cacheHitRate: cacheRead + tokensIn > 0 ? cacheRead / (cacheRead + tokensIn) : null,
        costUsd: cost.get(hash)?.costUsd ?? null,
      }
    })
  }

  // How many failed runs the detail view lists. Enough to spot a pattern,
  // few enough that the payload stays small — the full set is one click away
  // in the run list, already filtered by agent and failure class.
  private static readonly RECENT_FAILURES = 20
  // error_msg can hold a whole raw API response (see Agent.ts's truncated
  // branch); the detail view only needs enough to recognise the failure.
  private static readonly ERROR_EXCERPT_CHARS = 400

  agentDetail(agentId: string, filters: ExecutionStatsFilters): AgentDetail | null {
    // Reuse stats() rather than re-deriving the summary: the header of the
    // detail must be the same number the panel row showed, not a second
    // calculation that can disagree with it.
    const health = this.stats({ ...filters, agentId }).agents.find((a) => a.agentId === agentId)
    if (!health) return null

    const { where, params } = this.statsWhere({ ...filters, agentId })

    // Dos cortes por versión: la config del agente y los system prompts. Si
    // el segundo se movió y el primero muestra las mismas versiones, lo que
    // cambió fue un prompt compartido por todo el roster, no este agente.
    const byPromptVersion = this.versionStats('agent_prompt_hash', where, params).map(
      ({ hash, ...rest }) => ({ promptHash: hash, ...rest }),
    )
    const bySystemPromptVersion = this.versionStats('system_prompt_hash', where, params).map(
      ({ hash, ...rest }) => ({ systemPromptHash: hash, ...rest }),
    )

    const byDay = (
      this.db
        .query(`SELECT substr(started_at, 1, 10)                            AS day,
                       COUNT(*)                                             AS runs,
                       SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success
                  FROM execution_logs ${where}
                 GROUP BY day
                 ORDER BY day ASC`)
        .all(...(params as string[])) as Array<Record<string, unknown>>
    ).map((r) => ({
      day: r.day as string,
      runs: Number(r.runs ?? 0),
      success: Number(r.success ?? 0),
    }))

    const failureRows = this.db
      .query(`SELECT id, task_id, task_title, started_at, outcome, failure_class, stop_reason,
                     error_msg
                FROM execution_logs ${where} AND outcome != 'success'
               ORDER BY started_at DESC
               LIMIT ?`)
      .all(...(params as string[]), SqliteExecutionLogRepository.RECENT_FAILURES) as Array<
      Record<string, unknown>
    >

    return {
      agentId,
      health,
      byPromptVersion,
      bySystemPromptVersion,
      byDay,
      recentFailures: failureRows.map((r) => {
        const raw = (r.error_msg as string | null) ?? null
        return {
          id: r.id as string,
          taskId: r.task_id as string,
          taskTitle: r.task_title as string,
          startedAt: r.started_at as string,
          outcome: (r.outcome as AgentDetail['recentFailures'][number]['outcome']) ?? null,
          failureClass:
            (r.failure_class as AgentDetail['recentFailures'][number]['failureClass']) ?? null,
          stopReason: (r.stop_reason as string | null) ?? null,
          errorExcerpt:
            raw === null ? null : raw.slice(0, SqliteExecutionLogRepository.ERROR_EXCERPT_CHARS),
        }
      }),
    }
  }
}
