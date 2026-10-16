/**
 * `TraceInsight` sobre la base de ejecuciones (`executions` + `execution_trace`, las tablas que
 * escriben `SqliteExecutionRepository` y `SqliteTraceJournal`): la búsqueda entre todas las
 * trazas guardadas, el último paso de una ejecución y cada agente de una ejecución por separado.
 * Todo en SQL: una traza puede tener miles de entradas y leerlas enteras para filtrarlas en
 * memoria no escala a "todas las ejecuciones".
 */
import type { Database } from 'bun:sqlite'
import type {
  AgentRun,
  TraceInsight,
  TraceSearchHit,
  TraceSearchQuery,
  TraceSearchResult,
  TraceSearchSample,
} from '../assistant/TraceInsight.js'
import { taskOfKey } from '../inbox/ActivityPort.js'

/** Cuánto texto rodea a lo que coincidió en el extracto de una entrada. */
const EXCERPT_BEFORE = 60
const EXCERPT_AFTER = 120

const AGENT_ID = `json_extract(t.attributes_json, '$."ia.agent.id"')`

/** Una entrada que contiene `$text` (ya en minúsculas) y pasa los filtros de la entrada. */
const ENTRY_MATCH = `(instr(lower(t.name), $text) > 0
    OR instr(lower(COALESCE(t.status_message, '')), $text) > 0
    OR instr(lower(t.attributes_json), $text) > 0)
  AND ($since IS NULL OR t.start_time >= $since)
  AND ($until IS NULL OR t.start_time <= $until)
  AND ($agent IS NULL OR ${AGENT_ID} = $agent)`

/** Una ejecución cuya `key` (JSON de pares) tiene `[name, $param]` (o `$param` es NULL) — el
 *  mismo criterio que `SqliteActivityReader.executions` para la task. */
const keyHas = (
  name: string,
  param: string,
) => `(${param} IS NULL OR CASE WHEN json_valid(e.key) THEN EXISTS (
    SELECT 1 FROM json_each(e.key) AS pair
    WHERE pair.type = 'array'
      AND CASE WHEN pair.type = 'array' THEN json_extract(pair.value, '$[0]') END = '${name}'
      AND CASE WHEN pair.type = 'array' THEN CAST(json_extract(pair.value, '$[1]') AS TEXT) END = ${param}
  ) ELSE 0 END)`

interface HitRow {
  id: string
  key: string
  pipeline_id: string
  status: TraceSearchHit['status']
  started_at: string
  matches: number
}

interface SampleRow {
  idx: number
  name: string
  start_time: string
  status_message: string | null
  attributes_json: string
  agent: string | null
}

interface AgentSpanRow {
  phase: 'start' | 'end' | null
  span_id: string
  status: AgentRun['status'] | null
  status_message: string | null
  start_time: string
  end_time: string | null
  attributes_json: string
}

/** Un pedazo de `haystack` alrededor de la primera aparición de `needle` (en minúsculas). */
export function excerptAround(haystack: string, needle: string): string {
  const at = haystack.toLowerCase().indexOf(needle)
  if (at < 0) return haystack.slice(0, EXCERPT_BEFORE + EXCERPT_AFTER)
  const from = Math.max(at - EXCERPT_BEFORE, 0)
  const to = Math.min(at + needle.length + EXCERPT_AFTER, haystack.length)
  return `${from > 0 ? '…' : ''}${haystack.slice(from, to)}${to < haystack.length ? '…' : ''}`
}

function sampleOf(row: SampleRow, needle: string): TraceSearchSample {
  const where = [row.name, row.status_message ?? '', row.attributes_json].find((text) =>
    text.toLowerCase().includes(needle),
  )
  return {
    index: row.idx,
    name: row.name,
    at: row.start_time,
    ...(row.agent ? { agent: row.agent } : {}),
    excerpt: excerptAround(where ?? row.name, needle),
  }
}

export class SqliteTraceInsight implements TraceInsight {
  constructor(private readonly db: Database) {}

  search(query: TraceSearchQuery): TraceSearchResult {
    const needle = query.text.trim().toLowerCase()
    if (!needle) throw new Error('La búsqueda necesita un texto')
    const entryParams = {
      $text: needle,
      $since: query.since ?? null,
      $until: query.until ?? null,
      $agent: query.agentId ?? null,
    }
    const rows = this.db
      .prepare(
        `SELECT e.id, e.key, e.pipeline_id, e.status, e.started_at, COUNT(*) AS matches
         FROM execution_trace AS t JOIN executions AS e ON e.id = t.execution_id
         WHERE ${ENTRY_MATCH}
           AND ($pipeline IS NULL OR e.pipeline_id = $pipeline)
           AND ($status IS NULL OR e.status = $status)
           AND ${keyHas('issue', '$taskRef')}
           AND ${keyHas('projectId', '$projectId')}
         GROUP BY e.id
         ORDER BY e.started_at DESC, e.id
         LIMIT $limit`,
      )
      .all({
        ...entryParams,
        $pipeline: query.pipelineId ?? null,
        $status: query.status ?? null,
        $taskRef: query.taskRef ?? null,
        $projectId: query.projectId ?? null,
        $limit: query.limit + 1,
      }) as HitRow[]

    const samples = this.db.prepare(
      `SELECT t.name, t.start_time, t.status_message, t.attributes_json, ${AGENT_ID} AS agent,
         (SELECT COUNT(*) FROM execution_trace AS p
          WHERE p.execution_id = t.execution_id AND p.seq < t.seq) AS idx
       FROM execution_trace AS t
       WHERE t.execution_id = $id AND ${ENTRY_MATCH}
       ORDER BY t.seq LIMIT $samples`,
    )
    const agents = this.db.prepare(
      `SELECT DISTINCT ${AGENT_ID} AS agent FROM execution_trace AS t
       WHERE t.execution_id = $id AND ${AGENT_ID} IS NOT NULL AND ${ENTRY_MATCH}`,
    )

    const executions = rows.slice(0, query.limit).map((row): TraceSearchHit => {
      const params = { ...entryParams, $id: row.id }
      const task = taskOfKey(row.key)
      return {
        execution_id: row.id,
        ...(task.taskRef ? { task_ref: task.taskRef } : {}),
        ...(task.projectId ? { project_id: task.projectId } : {}),
        pipeline_id: row.pipeline_id,
        status: row.status,
        started_at: row.started_at,
        agents: (agents.all(params) as Array<{ agent: string }>).map((found) => found.agent),
        matches: Number(row.matches),
        samples: (samples.all({ ...params, $samples: query.samples }) as SampleRow[]).map(
          (sample) => sampleOf(sample, needle),
        ),
      }
    })
    return { executions, truncated: rows.length > query.limit }
  }

  lastStepAt(executionIds: readonly string[]): Map<string, string> {
    if (executionIds.length === 0) return new Map()
    const rows = this.db
      .prepare(
        `SELECT execution_id, MAX(COALESCE(end_time, start_time)) AS last_at FROM execution_trace
         WHERE execution_id IN (SELECT value FROM json_each($ids))
         GROUP BY execution_id`,
      )
      .all({ $ids: JSON.stringify(executionIds) }) as Array<{
      execution_id: string
      last_at: string
    }>
    return new Map(rows.map((row) => [row.execution_id, row.last_at]))
  }

  agentRuns(executionId: string): AgentRun[] {
    const lastAt = new Map(
      (
        this.db
          .prepare(
            `SELECT ${AGENT_ID} AS agent, MAX(COALESCE(t.end_time, t.start_time)) AS last_at
             FROM execution_trace AS t
             WHERE t.execution_id = $id AND ${AGENT_ID} IS NOT NULL
             GROUP BY agent`,
          )
          .all({ $id: executionId }) as Array<{ agent: string; last_at: string }>
      ).map((row) => [String(row.agent), row.last_at]),
    )
    const spans = this.db
      .prepare(
        `SELECT t.phase, t.span_id, t.status, t.status_message, t.start_time, t.end_time,
           t.attributes_json
         FROM execution_trace AS t
         WHERE t.execution_id = $id AND t.kind = 'span'
           AND json_extract(t.attributes_json, '$."ia.step.kind"') = 'agent'
           AND ${AGENT_ID} IS NOT NULL
         ORDER BY t.seq`,
      )
      .all({ $id: executionId }) as AgentSpanRow[]

    // La última corrida de cada agente: la del último span que abrió (o, si sólo llegó el cierre —
    // la telemetría de un host remoto —, la del último que cerró).
    const runs = new Map<string, { spanId: string; run: AgentRun }>()
    for (const span of spans) {
      const attributes = JSON.parse(span.attributes_json) as Record<string, unknown>
      const agentId = String(attributes['ia.agent.id'])
      const current = runs.get(agentId)
      const sameSpan = current?.spanId === span.span_id
      const run: AgentRun = sameSpan
        ? (current?.run as AgentRun)
        : {
            agent_id: agentId,
            started_at: span.start_time,
            last_step_at: lastAt.get(agentId) ?? span.start_time,
          }
      if (span.phase !== 'start') Object.assign(run, ending(span, attributes))
      runs.set(agentId, { spanId: span.span_id, run })
    }
    return [...runs.values()]
      .map(({ run }) => run)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
  }
}

/** Lo que dice el cierre del span de un agente (los atributos de `stepTrace`). */
function ending(span: AgentSpanRow, attributes: Record<string, unknown>): Partial<AgentRun> {
  const text = (key: string) => {
    const value = attributes[key]
    return typeof value === 'string' && value ? value : undefined
  }
  const fields: Partial<AgentRun> = {
    ended_at: span.end_time ?? span.start_time,
    ...(span.status ? { status: span.status } : {}),
    ...(span.status === 'error' ? { failure: span.status_message ?? 'error' } : {}),
  }
  for (const [field, key] of [
    ['exit', 'ia.agent.exit'],
    ['summary', 'ia.agent.summary'],
    ['waiting', 'ia.agent.waiting'],
    ['interrupted_by', 'ia.agent.interrupted_by'],
  ] as const) {
    const value = text(key)
    if (value) fields[field] = value
  }
  return fields
}
