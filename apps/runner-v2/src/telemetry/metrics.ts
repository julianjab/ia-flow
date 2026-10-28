/**
 * Las métricas del runner en formato Prometheus (`GET /metrics`): lo que necesita un Grafana que
 * sólo tiene Prometheus (sin Tempo ni Loki) para mostrar costo y actividad. Salen de los mismos
 * registros que la base de actividad (`TraceRecord`, del runner y de sus hosts):
 *
 *   ia_flow_llm_requests_total      {agent, pipeline, project, repo, model, origin}
 *   ia_flow_llm_tokens_total        {…, type: input | output | cache_read | cache_write}
 *   ia_flow_llm_cost_usd_total      {…, billing: api | subscription}
 *   ia_flow_pipeline_runs_total     {pipeline, project, repo, status}
 *   ia_flow_pipeline_duration_seconds (histograma) {pipeline, project, status}
 *   ia_flow_agent_runs_total        {agent, pipeline, project, repo, provider, status}
 *   ia_flow_executions              {state: running | paused | waiting} — al leer
 *
 * Los tokens son los de un span terminado con `gen_ai.usage.*`, con el mismo modelo que
 * `usageByModel` del datasource (el de la respuesta, si no el del request). El costo es el
 * estimado a precio de lista (`pricing:`), no la factura: uno de suscripción va con
 * `billing="subscription"`. Contadores en memoria: un reinicio los pone en cero y `increase()`
 * de Prometheus lo absorbe.
 */
import type { TraceRecord, TraceValue } from '@ia-flow/telemetry'

/** Los tokens de un request al modelo, como los lee el precio. */
export interface TokenUsage {
  model: string
  scope?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Cuánto cuestan unos tokens, y si se pagan por token o salen de una suscripción. `undefined`:
 *  un modelo sin precio (se cuentan sus tokens, no su costo). */
export type CostOf = (
  usage: TokenUsage,
) => { usd: number; billing: 'api' | 'subscription' } | undefined

export interface ExecutionGauges {
  running: number
  paused: number
  waiting: number
}

/** En segundos: de un refiner corto a un implementer que espera el CI. */
export const DURATION_BUCKETS = [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200]

const TOKEN_TYPES = [
  ['input', 'gen_ai.usage.input_tokens'],
  ['output', 'gen_ai.usage.output_tokens'],
  ['cache_read', 'gen_ai.usage.cache_read_input_tokens'],
  ['cache_write', 'gen_ai.usage.cache_creation_input_tokens'],
] as const

type Labels = Record<string, string>

/** Un contador por combinación de labels. */
class Counter {
  private readonly series = new Map<string, { labels: Labels; value: number }>()

  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  add(labels: Labels, value: number): void {
    if (!(value > 0)) return
    const key = seriesKey(labels)
    const current = this.series.get(key)
    if (current) current.value += value
    else this.series.set(key, { labels, value })
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const { labels, value } of this.series.values()) {
      lines.push(`${this.name}${labelText(labels)} ${value}`)
    }
    return lines
  }
}

class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >()

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const key = seriesKey(labels)
    let current = this.series.get(key)
    if (!current) {
      current = { labels, buckets: this.bounds.map(() => 0), sum: 0, count: 0 }
      this.series.set(key, current)
    }
    for (const [index, bound] of this.bounds.entries()) {
      if (value <= bound) current.buckets[index] = (current.buckets[index] ?? 0) + 1
    }
    current.sum += value
    current.count += 1
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const { labels, buckets, sum, count } of this.series.values()) {
      for (const [index, bound] of this.bounds.entries()) {
        lines.push(
          `${this.name}_bucket${labelText({ ...labels, le: String(bound) })} ${buckets[index]}`,
        )
      }
      lines.push(`${this.name}_bucket${labelText({ ...labels, le: '+Inf' })} ${count}`)
      lines.push(`${this.name}_sum${labelText(labels)} ${sum}`)
      lines.push(`${this.name}_count${labelText(labels)} ${count}`)
    }
    return lines
  }
}

export class RunnerMetrics {
  private readonly requests = new Counter(
    'ia_flow_llm_requests_total',
    'Requests al modelo, por agente, pipeline y modelo.',
  )
  private readonly tokens = new Counter(
    'ia_flow_llm_tokens_total',
    'Tokens de los requests al modelo, por tipo (input, output, cache_read, cache_write).',
  )
  private readonly cost = new Counter(
    'ia_flow_llm_cost_usd_total',
    'Costo estimado a precio de lista (pricing de runner.yaml), en USD.',
  )
  private readonly pipelineRuns = new Counter(
    'ia_flow_pipeline_runs_total',
    'Corridas de una pipeline terminadas: ok, o error si su span terminó en error.',
  )
  private readonly pipelineDuration = new Histogram(
    'ia_flow_pipeline_duration_seconds',
    'Duración de una corrida de pipeline, en segundos.',
    DURATION_BUCKETS,
  )
  private readonly agentRuns = new Counter(
    'ia_flow_agent_runs_total',
    'Pasos de agente terminados, por provider: ok, o error si su span terminó en error.',
  )

  constructor(
    private readonly costOf: CostOf,
    private readonly executions?: () => ExecutionGauges,
  ) {}

  /** Un registro de la base de actividad. Sólo miran los spans terminados. Nunca tira. */
  observe(record: TraceRecord): void {
    if (record.kind !== 'span' || record.phase !== 'end') return
    try {
      if (record.name.startsWith('pipeline ')) this.pipeline(record)
      else if (record.name.startsWith('agent ')) this.agent(record)
      if (hasUsage(record.attributes)) this.usage(record)
    } catch {
      // Una métrica rota no puede tumbar lo que se está trazando.
    }
  }

  /** El texto de exposición de Prometheus (`text/plain; version=0.0.4`). */
  render(): string {
    const lines = [
      ...this.requests.render(),
      ...this.tokens.render(),
      ...this.cost.render(),
      ...this.pipelineRuns.render(),
      ...this.pipelineDuration.render(),
      ...this.agentRuns.render(),
    ]
    const gauges = this.executions?.()
    if (gauges) {
      lines.push(
        '# HELP ia_flow_executions Ejecuciones del engine ahora, por estado.',
        '# TYPE ia_flow_executions gauge',
      )
      for (const state of ['running', 'paused', 'waiting'] as const) {
        lines.push(`ia_flow_executions${labelText({ state })} ${gauges[state]}`)
      }
    }
    return `${lines.join('\n')}\n`
  }

  private usage(record: TraceRecord): void {
    const attrs = record.attributes
    const model =
      text(attrs['gen_ai.response.model']) ?? text(attrs['gen_ai.request.model']) ?? 'unknown'
    const labels = {
      ...taskLabels(attrs),
      agent: text(attrs['ia.agent.id']) ?? '',
      model,
      origin: record.origin,
    }
    this.requests.add(labels, 1)
    for (const [type, key] of TOKEN_TYPES) this.tokens.add({ ...labels, type }, num(attrs[key]))
    const priced = this.costOf({
      model,
      ...(record.scope ? { scope: record.scope } : {}),
      inputTokens: num(attrs['gen_ai.usage.input_tokens']),
      outputTokens: num(attrs['gen_ai.usage.output_tokens']),
      cacheReadTokens: num(attrs['gen_ai.usage.cache_read_input_tokens']),
      cacheWriteTokens: num(attrs['gen_ai.usage.cache_creation_input_tokens']),
    })
    if (priced) this.cost.add({ ...labels, billing: priced.billing }, priced.usd)
  }

  private pipeline(record: TraceRecord): void {
    const attrs = record.attributes
    const pipeline = text(attrs['ia.pipeline.id']) ?? record.name.slice('pipeline '.length)
    const status = outcome(record)
    this.pipelineRuns.add({ ...taskLabels(attrs), pipeline, status }, 1)
    if (record.durationMs !== undefined) {
      this.pipelineDuration.observe(
        { pipeline, project: text(attrs['ia.projectId']) ?? '', status },
        record.durationMs / 1000,
      )
    }
  }

  private agent(record: TraceRecord): void {
    const attrs = record.attributes
    this.agentRuns.add(
      {
        ...taskLabels(attrs),
        agent: text(attrs['ia.agent.id']) ?? record.name.slice('agent '.length),
        provider: text(attrs['ia.agent.provider']) ?? '',
        status: outcome(record),
      },
      1,
    )
  }
}

/** Un span sin error queda `unset`: para un dashboard, eso es `ok`. */
const outcome = (record: TraceRecord): 'ok' | 'error' =>
  record.status === 'error' ? 'error' : 'ok'

/** Los labels de la task que heredan todos los spans de una ejecución. */
function taskLabels(attrs: Record<string, TraceValue>): Labels {
  return {
    pipeline: text(attrs['ia.pipeline.id']) ?? '',
    project: text(attrs['ia.projectId']) ?? '',
    repo: text(attrs['ia.repo']) ?? '',
  }
}

function hasUsage(attrs: Record<string, TraceValue>): boolean {
  return (
    attrs['gen_ai.usage.input_tokens'] !== undefined ||
    attrs['gen_ai.usage.output_tokens'] !== undefined
  )
}

const text = (value: TraceValue | undefined): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const num = (value: TraceValue | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join('\u0000')
}

function labelText(labels: Labels): string {
  const pairs = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`)
  return pairs.length > 0 ? `{${pairs.join(',')}}` : ''
}

/** Lo que el formato de texto de Prometheus pide escapar en el valor de un label. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
