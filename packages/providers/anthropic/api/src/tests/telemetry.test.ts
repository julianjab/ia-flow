import type { EventBus, ProviderRunContext, Tool } from '@ia-flow/agent-engine'
import { createEvent } from '@ia-flow/agent-engine'
import { withInheritedAttributes, withSpan } from '@ia-flow/telemetry'
import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicProvider } from '../AnthropicProvider.js'

const spans = new InMemorySpanExporter()

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] }),
  )
})
afterAll(() => {
  trace.disable()
  context.disable()
})
beforeEach(() => spans.reset())

const byName = (name: string): ReadableSpan[] =>
  spans.getFinishedSpans().filter((span) => span.name === name)

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function tool(name: string, handler: Tool['handler']): Tool {
  return { name, description: name, inputSchema: { type: 'object' }, handler }
}

function ctxFor(tools: Tool[]): ProviderRunContext {
  return {
    agentId: 'refiner',
    prompt: 'hola',
    systemPrompts: [],
    variables: {},
    providerConfig: {},
    mcpServers: [],
    tools,
    ctx: { event: createEvent('a', {}), steps: {}, bus: {} as EventBus, pipelineId: 'p' },
  }
}

/** Vuelta 1: MCP server-side + dos tools locales (una falla). Vuelta 2: termina. */
function twoRounds() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        stop_reason: 'tool_use',
        usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 1000 },
        content: [
          { type: 'text', text: 'Miro el repo.' },
          {
            type: 'mcp_tool_use',
            id: 'm1',
            name: 'get_file_contents',
            server_name: 'github-mcp',
            input: { path: 'README.md' },
          },
          { type: 'mcp_tool_result', tool_use_id: 'm1', content: 'leído' },
          { type: 'tool_use', id: 't1', name: 'lookup', input: { q: 'x' } },
          { type: 'tool_use', id: 't2', name: 'broken', input: {} },
        ],
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        stop_reason: 'end_turn',
        usage: { input_tokens: 1500, output_tokens: 20 },
        content: [{ type: 'text', text: 'listo' }],
      }),
    )
}

function provider(fetchImpl: ReturnType<typeof vi.fn>) {
  return new AnthropicProvider({
    id: 'anthropic-api',
    model: 'claude-x',
    apiKey: 'sk',
    stream: false,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

describe('AnthropicProvider telemetry', () => {
  it('opens a GenAI chat span per request with token usage and finish reason', async () => {
    await provider(twoRounds()).run(
      ctxFor([
        tool('lookup', async () => 'ok'),
        tool('broken', async () => {
          throw new Error('rota')
        }),
      ]),
    )

    const chats = byName('chat claude-x')
    expect(chats).toHaveLength(2)
    expect(chats[0]?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-x',
      'gen_ai.usage.input_tokens': 1200,
      'gen_ai.usage.output_tokens': 80,
      'gen_ai.usage.cache_read_input_tokens': 1000,
      'gen_ai.response.finish_reasons': ['tool_use'],
      'ia.round': 0,
    })
    expect(chats[1]?.attributes['gen_ai.response.finish_reasons']).toEqual(['end_turn'])
  })

  it('shows what the model did server-side (MCP) as events of the request', async () => {
    await provider(twoRounds()).run(
      ctxFor([tool('lookup', async () => 'ok'), tool('broken', async () => 'x')]),
    )

    const events = byName('chat claude-x')[0]?.events.map((e) => [e.name, e.attributes])
    expect(events).toEqual([
      ['assistant.text', { 'ia.text': 'Miro el repo.' }],
      [
        'mcp_tool_use',
        {
          'gen_ai.tool.name': 'get_file_contents',
          'ia.mcp.server': 'github-mcp',
          'ia.tool.input': '{"path":"README.md"}',
        },
      ],
      ['mcp_tool_result', { 'ia.tool.is_error': false, 'ia.tool.result': 'leído' }],
    ])
  })

  it('opens an execute_tool span per local tool, in error when the tool failed', async () => {
    await provider(twoRounds()).run(
      ctxFor([
        tool('lookup', async () => 'encontrado'),
        tool('broken', async () => {
          throw new Error('rota')
        }),
      ]),
    )

    const [lookup] = byName('execute_tool lookup')
    expect(lookup?.attributes).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'lookup',
      'gen_ai.tool.call.id': 't1',
      'ia.tool.input': '{"q":"x"}',
      'ia.tool.result': 'encontrado',
    })
    expect(lookup?.status.code).not.toBe(SpanStatusCode.ERROR)
    const [broken] = byName('execute_tool broken')
    expect(broken?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'Error: rota' })
  })

  it('hangs under the step that ran the agent and inherits the event scope', async () => {
    await withInheritedAttributes({ 'ia.issue': 'la-haus/front#1' }, () =>
      withSpan('agent refiner', {}, () =>
        provider(twoRounds()).run(
          ctxFor([tool('lookup', async () => 'ok'), tool('broken', async () => 'x')]),
        ),
      ),
    )

    const [step] = byName('agent refiner')
    const chat = byName('chat claude-x')[0]
    expect(chat?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId)
    expect(chat?.attributes['ia.issue']).toBe('la-haus/front#1')
    expect(byName('execute_tool lookup')[0]?.attributes['ia.issue']).toBe('la-haus/front#1')
  })
})
