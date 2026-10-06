import type { EventBus, McpServerRef, ProviderRunContext } from '@ia-flow/agent-engine'
import { createEvent } from '@ia-flow/agent-engine'
import { type LogRecord, otelSink, setLogLevel, setLogSinks } from '@ia-flow/telemetry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnthropicApiError } from '../AnthropicClient.js'
import { AnthropicProvider } from '../AnthropicProvider.js'
import { describeBlocks, describeConversation } from '../tracing.js'

let records: LogRecord[] = []

beforeEach(() => {
  records = []
  setLogSinks([(record) => records.push(record)])
})
afterEach(() => {
  setLogSinks([otelSink()])
  setLogLevel('info')
})

const find = (level: LogRecord['level'], text: string) =>
  records.find((record) => record.level === level && record.message.includes(text))

function jsonResponse(body: unknown, status = 200, requestId = 'req_ok') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': requestId },
  })
}

function ctx(mcpServers: McpServerRef[] = []): ProviderRunContext {
  return {
    agentId: 'refiner',
    prompt: 'hola',
    systemPrompts: [],
    variables: {},
    providerConfig: {},
    mcpServers,
    tools: [],
    ctx: { event: createEvent('a', {}), steps: {}, bus: {} as EventBus, pipelineId: 'p' },
  }
}

function provider(fetchImpl: ReturnType<typeof vi.fn>) {
  return new AnthropicProvider({
    id: 'anthropic-api',
    model: 'claude-x',
    apiKey: 'sk-ant-api03-SECRETSECRETSECRET',
    stream: false,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
}

/** Un `pause_turn` que corta con un `mcp_tool_use` sin result detrás de un `thinking` (el turno de
 *  subscriptions#1637), y una API que igual rechaza el reenvío. */
function pausedThenRejected() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'msg_1',
          model: 'claude-x-20260901',
          stop_reason: 'pause_turn',
          usage: { input_tokens: 10, output_tokens: 5, service_tier: 'standard' },
          content: [
            { type: 'thinking', thinking: 'pienso', signature: 's' },
            { type: 'mcp_tool_use', id: 'm1', name: 'search_code', server_name: 'github-mcp' },
          ],
        },
        200,
        'req_pause',
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'messages.1: The final block in an assistant message cannot be `thinking`.',
          },
          request_id: 'req_bad',
        },
        400,
        'req_bad',
      ),
    )
}

describe('describeBlocks / describeConversation', () => {
  it('lists block types in order, folding consecutive repeats', () => {
    expect(
      describeBlocks([
        { type: 'thinking' },
        { type: 'mcp_tool_use' },
        { type: 'mcp_tool_use' },
        { type: 'mcp_tool_result' },
      ]),
    ).toBe('thinking,mcp_tool_use×2,mcp_tool_result')
    expect(describeBlocks('texto plano')).toBe('text')
  })

  it('numbers each message the way a 400 cites it', () => {
    expect(
      describeConversation([
        { role: 'user', content: 'hola' },
        { role: 'assistant', content: [{ type: 'thinking' }] },
      ]),
    ).toBe('0:user[text] 1:assistant[thinking]')
  })
})

describe('AnthropicProvider diagnostics', () => {
  it('logs every response with its request id, response id, model and block shape', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        {
          id: 'msg_9',
          model: 'claude-x-20260901',
          stop_reason: 'end_turn',
          usage: { input_tokens: 3, output_tokens: 2 },
          content: [{ type: 'thinking' }, { type: 'text', text: 'listo' }],
        },
        200,
        'req_9',
      ),
    )

    await provider(fetchImpl).run(ctx())

    expect(find('info', 'chat round 0 → end_turn')?.attributes).toMatchObject({
      'anthropic.request_id': 'req_9',
      'gen_ai.response.id': 'msg_9',
      'gen_ai.response.model': 'claude-x-20260901',
      'ia.response.blocks': 'thinking,text',
      'gen_ai.usage.input_tokens': 3,
    })
  })

  it('leaves the trail of a rejected request: the pause, and the shape it sent', async () => {
    const run = provider(pausedThenRejected()).run(ctx())

    const err = await run.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AnthropicApiError)
    expect(err).toMatchObject({
      status: 400,
      requestId: 'req_bad',
      errorType: 'invalid_request_error',
    })

    expect(find('info', 'pause_turn')?.attributes).toMatchObject({
      'ia.response.blocks': 'thinking,mcp_tool_use',
    })
    expect(find('warn', 'la API rechazó')?.attributes).toMatchObject({
      'anthropic.request_id': 'req_bad',
      'error.type': 'invalid_request_error',
      'http.response.status_code': 400,
      'ia.request.shape': '0:user[text] 1:assistant[thinking,mcp_tool_use]',
    })
  })

  it('warns when a resumed conversation carried an unanswered MCP call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }),
      )
    const resumed = {
      ...ctx(),
      providerConfig: {
        resumeMessages: [
          { role: 'user', content: 'hola' },
          { role: 'assistant', content: [{ type: 'mcp_tool_use', id: 'm1', name: 'search_code' }] },
          { role: 'user', content: 'Continuá.' },
        ],
      },
    }

    await provider(fetchImpl).run(resumed)

    expect(find('warn', 'mcp_tool_use sin result')?.attributes).toMatchObject({
      'ia.message.index': 1,
      'ia.paired': JSON.stringify([{ id: 'm1', name: 'search_code' }]),
    })
  })

  it('dumps nothing at the default level', async () => {
    await provider(pausedThenRejected())
      .run(ctx())
      .catch(() => {})

    expect(records.filter((record) => record.level === 'debug')).toEqual([])
  })

  it('dumps each request and response in debug mode, with the credentials hidden', async () => {
    setLogLevel('debug')
    const server: McpServerRef = {
      id: 'github-mcp',
      config: { url: 'https://mcp.example', authorizationToken: 'ghp_TOKENTOKENTOKENTOKENTOKEN' },
    }

    await provider(pausedThenRejected())
      .run(ctx([server]))
      .catch(() => {})

    const request = find('debug', 'anthropic request round 0')?.attributes
    expect(request?.['ia.request.params']).toContain('"authorization_token":"[REDACTED]"')
    expect(request?.['ia.request.params']).toContain('mcp-client-2025-11-20')
    expect(request?.['ia.request.messages']).toContain('hola')
    expect(
      find('debug', 'anthropic response round 0')?.attributes['ia.response.content'],
    ).toContain('search_code')
    expect(find('debug', 'anthropic request rechazado round 1')).toBeDefined()

    const everything = JSON.stringify(records)
    expect(everything).not.toContain('TOKENTOKEN')
    expect(everything).not.toContain('SECRETSECRET')
  })
})
