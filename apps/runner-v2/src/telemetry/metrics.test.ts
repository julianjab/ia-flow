import { describe, expect, it } from 'bun:test'
import type { TraceRecord } from '@ia-flow/telemetry'
import { type CostOf, RunnerMetrics } from './metrics.js'

const TASK = {
  'ia.execution.id': 'e1',
  'ia.pipeline.id': 'build-arrival',
  'ia.projectId': 'lahaus-ai-flow',
  'ia.repo': 'la-haus/subscriptions',
}

function span(
  name: string,
  attributes: TraceRecord['attributes'],
  extra: Partial<TraceRecord> = {},
) {
  return {
    kind: 'span',
    phase: 'end',
    name,
    status: 'ok',
    startTime: '2026-10-28T00:00:00.000Z',
    traceId: 't',
    spanId: 's',
    executionId: 'e1',
    origin: 'runner',
    attributes: { ...TASK, ...attributes },
    ...extra,
  } satisfies TraceRecord
}

const chat = (attributes: TraceRecord['attributes'], extra: Partial<TraceRecord> = {}) =>
  span(
    'chat claude-opus-5-5',
    {
      'ia.agent.id': 'implementer',
      'gen_ai.request.model': 'claude-opus-5-5',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read_input_tokens': 1000,
      'gen_ai.usage.cache_creation_input_tokens': 0,
      ...attributes,
    },
    extra,
  )

/** Un dólar por token de salida: fácil de seguir en los asserts. */
const perOutput: CostOf = (usage) =>
  usage.model === 'sin-precio'
    ? undefined
    : {
        usd: usage.outputTokens,
        billing: usage.scope === 'subscription-scope' ? 'subscription' : 'api',
      }

/** El valor de la serie cuyo nombre y labels contienen todo lo que se pide. */
function value(text: string, name: string, ...labels: string[]): number | undefined {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${name}{`) && labels.every((label) => l.includes(label)))
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1))
}

describe('RunnerMetrics', () => {
  it('adds up the tokens, requests and cost of each agent, pipeline and model', () => {
    const metrics = new RunnerMetrics(perOutput)
    metrics.observe(chat({}))
    metrics.observe(chat({ 'gen_ai.usage.output_tokens': 5 }))

    const text = metrics.render()
    const labels = ['agent="implementer"', 'pipeline="build-arrival"', 'model="claude-opus-5-5"']
    expect(value(text, 'ia_flow_llm_requests_total', ...labels)).toBe(2)
    expect(value(text, 'ia_flow_llm_tokens_total', ...labels, 'type="output"')).toBe(25)
    expect(value(text, 'ia_flow_llm_tokens_total', ...labels, 'type="cache_read"')).toBe(2000)
    expect(value(text, 'ia_flow_llm_cost_usd_total', ...labels, 'billing="api"')).toBe(25)
    expect(text).toContain('repo="la-haus/subscriptions"')
    expect(text).toContain('# TYPE ia_flow_llm_tokens_total counter')
  })

  it('uses the response model over the requested one, like the datasource', () => {
    const metrics = new RunnerMetrics(perOutput)
    metrics.observe(chat({ 'gen_ai.response.model': 'claude-sonnet-5-5' }))

    expect(value(metrics.render(), 'ia_flow_llm_requests_total', 'model="claude-sonnet-5-5"')).toBe(
      1,
    )
  })

  it('separates subscription usage by billing, and counts tokens of a model without price', () => {
    const metrics = new RunnerMetrics(perOutput)
    metrics.observe(chat({}, { scope: 'subscription-scope', origin: 'remote:e2e' }))
    metrics.observe(chat({ 'gen_ai.request.model': 'sin-precio' }))

    const text = metrics.render()
    expect(
      value(text, 'ia_flow_llm_cost_usd_total', 'origin="remote:e2e"', 'billing="subscription"'),
    ).toBe(20)
    expect(value(text, 'ia_flow_llm_tokens_total', 'model="sin-precio"', 'type="output"')).toBe(20)
    expect(value(text, 'ia_flow_llm_cost_usd_total', 'model="sin-precio"')).toBeUndefined()
  })

  it('counts pipeline runs by status, with their duration in a histogram', () => {
    const metrics = new RunnerMetrics(perOutput)
    metrics.observe(span('pipeline build-arrival', {}, { durationMs: 90_000 }))
    metrics.observe(span('pipeline build-arrival', {}, { status: 'error', durationMs: 10_000 }))

    const text = metrics.render()
    expect(
      value(text, 'ia_flow_pipeline_runs_total', 'pipeline="build-arrival"', 'status="ok"'),
    ).toBe(1)
    expect(value(text, 'ia_flow_pipeline_runs_total', 'status="error"')).toBe(1)
    expect(value(text, 'ia_flow_pipeline_duration_seconds_bucket', 'status="ok"', 'le="60"')).toBe(
      0,
    )
    expect(value(text, 'ia_flow_pipeline_duration_seconds_bucket', 'status="ok"', 'le="120"')).toBe(
      1,
    )
    expect(value(text, 'ia_flow_pipeline_duration_seconds_sum', 'status="ok"')).toBe(90)
  })

  it('a span that ended without error counts as ok', () => {
    const metrics = new RunnerMetrics(perOutput)
    metrics.observe(span('pipeline refine', { 'ia.pipeline.id': 'refine' }, { status: 'unset' }))

    expect(
      value(metrics.render(), 'ia_flow_pipeline_runs_total', 'pipeline="refine"', 'status="ok"'),
    ).toBe(1)
  })

  it('counts agent steps by the provider they ran in', () => {
    const metrics = new RunnerMetrics(perOutput)
    metrics.observe(
      span('agent implementer', {
        'ia.agent.id': 'implementer',
        'ia.agent.provider': 'anthropic-api',
      }),
    )

    expect(
      value(
        metrics.render(),
        'ia_flow_agent_runs_total',
        'agent="implementer"',
        'provider="anthropic-api"',
      ),
    ).toBe(1)
  })

  it('ignores logs and spans that are only starting', () => {
    const metrics = new RunnerMetrics(perOutput)
    metrics.observe({ ...chat({}), phase: 'start' })
    metrics.observe({ ...chat({}), kind: 'log' })

    expect(metrics.render()).not.toContain('ia_flow_llm_requests_total{')
  })

  it('reports the executions right now as a gauge, and escapes label values', () => {
    const metrics = new RunnerMetrics(perOutput, () => ({ running: 2, paused: 1, waiting: 0 }))
    metrics.observe(chat({ 'ia.agent.id': 'a"b\\c' }))

    const text = metrics.render()
    expect(text).toContain('ia_flow_executions{state="running"} 2')
    expect(text).toContain('ia_flow_executions{state="paused"} 1')
    expect(text).toContain('agent="a\\"b\\\\c"')
  })
})
