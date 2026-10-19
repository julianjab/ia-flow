import type {
  EventBus,
  PipelineExecutionContext,
  ProviderRunContext,
  Tool,
} from '@ia-flow/agent-engine'
import { createEvent } from '@ia-flow/agent-engine'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicProvider, parseAnthropicAgentConfig } from '../AnthropicProvider.js'
import { buildContextManagement, clipToolResult } from '../context.js'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function ctxFor(overrides: Partial<ProviderRunContext> = {}): ProviderRunContext {
  const execCtx = {
    event: createEvent('a', {}),
    steps: {},
    bus: {} as EventBus,
    pipelineId: 'p',
  } satisfies PipelineExecutionContext
  return {
    agentId: 'x',
    prompt: 'hola',
    systemPrompts: [],
    variables: {},
    providerConfig: {},
    mcpServers: [],
    tools: [],
    ctx: execCtx,
    ...overrides,
  }
}

/** Un provider cuya primera vuelta pide `read` y la segunda cierra; devuelve los requests. */
function readThenFinish(options: Record<string, unknown> = {}) {
  const requests: Array<{ body: Record<string, unknown>; headers: Record<string, string> }> = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    requests.push({
      body: JSON.parse(init.body as string),
      headers: init.headers as Record<string, string>,
    })
    return requests.length === 1
      ? jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'read', input: {} }],
          stop_reason: 'tool_use',
        })
      : jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' })
  })
  const provider = new AnthropicProvider({
    id: 'x',
    model: 'claude-x',
    apiKey: 'sk',
    stream: false,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...options,
  })
  return { provider, requests }
}

/** El primer `tool_result` del último mensaje de un request. */
function lastToolResult(
  body: Record<string, unknown> | undefined,
): { content: string } | undefined {
  const messages = (body?.messages ?? []) as Array<{ content: Array<{ content: string }> }>
  return messages.at(-1)?.content[0]
}

const readTool = (content: string): Tool => ({
  name: 'read',
  description: 'lee',
  inputSchema: { type: 'object' },
  handler: () => content,
})

describe('buildContextManagement', () => {
  it('con true manda clear_tool_uses con los defaults', () => {
    expect(buildContextManagement(true)).toEqual({
      edits: [
        {
          type: 'clear_tool_uses_20250919',
          trigger: { type: 'input_tokens', value: 100_000 },
          keep: { type: 'tool_uses', value: 5 },
          clear_at_least: { type: 'input_tokens', value: 20_000 },
        },
      ],
    })
  })

  it('un objeto pisa sólo lo que define, y suma exclude_tools', () => {
    expect(buildContextManagement({ triggerTokens: 50_000, excludeTools: ['update_prd'] })).toEqual(
      {
        edits: [
          {
            type: 'clear_tool_uses_20250919',
            trigger: { type: 'input_tokens', value: 50_000 },
            keep: { type: 'tool_uses', value: 5 },
            clear_at_least: { type: 'input_tokens', value: 20_000 },
            exclude_tools: ['update_prd'],
          },
        ],
      },
    )
  })

  it('con false no manda nada', () => {
    expect(buildContextManagement(false)).toBeUndefined()
  })

  it('con thinking en el request, clear_thinking conserva todo y va primero', () => {
    const edits = buildContextManagement(true, true)?.edits as Array<{ type: string }>
    expect(edits[0]).toEqual({ type: 'clear_thinking_20251015', keep: 'all' })
    expect(edits[1]?.type).toBe('clear_tool_uses_20250919')
  })
})

describe('clipToolResult', () => {
  it('deja intacto lo que entra en el tope', () => {
    expect(clipToolResult('abc', 3)).toBe('abc')
  })

  it('se queda con el principio y avisa cuánto recortó', () => {
    const clipped = clipToolResult('a'.repeat(10), 4)
    expect(clipped.startsWith('aaaa\n')).toBe(true)
    expect(clipped).toContain('los primeros 4 de 10 caracteres')
  })
})

describe('AnthropicProvider — contexto', () => {
  it('por default no manda context_management ni la beta', async () => {
    const { provider, requests } = readThenFinish()

    await provider.run(ctxFor({ tools: [readTool('ok')] }))

    expect(requests[0]?.body.context_management).toBeUndefined()
    expect(requests[0]?.headers['anthropic-beta'] ?? '').not.toContain('context-management')
  })

  it('con clearToolUses: true manda context_management con su beta', async () => {
    const { provider, requests } = readThenFinish({ clearToolUses: true })

    await provider.run(ctxFor({ tools: [readTool('ok')] }))

    for (const { body, headers } of requests) {
      expect(body.context_management).toEqual(buildContextManagement(true))
      expect(headers['anthropic-beta']).toContain('context-management-2025-06-27')
    }
  })

  it('con thinking, clear_thinking va en el mismo context_management', async () => {
    const { provider, requests } = readThenFinish({
      clearToolUses: true,
      thinking: { type: 'adaptive' },
    })

    await provider.run(ctxFor({ tools: [readTool('ok')] }))

    expect(requests[0]?.body.context_management).toEqual(buildContextManagement(true, true))
  })

  it('el clearToolUses del agente pisa al del provider', async () => {
    const { provider, requests } = readThenFinish({ clearToolUses: false })

    await provider.run(
      ctxFor({
        tools: [readTool('ok')],
        providerConfig: { clearToolUses: { keepToolUses: 2 } },
      }),
    )

    expect(requests[0]?.body.context_management).toEqual(
      buildContextManagement({ keepToolUses: 2 }),
    )
  })

  it('un resultado más largo que maxToolResultChars entra recortado; onToolResult lo ve entero', async () => {
    const onToolResult = vi.fn()
    const { provider, requests } = readThenFinish({ maxToolResultChars: 100, onToolResult })
    const huge = 'x'.repeat(5000)

    await provider.run(ctxFor({ tools: [readTool(huge)] }))

    const result = lastToolResult(requests[1]?.body)
    expect(result?.content).toBe(clipToolResult(huge, 100))
    expect(onToolResult).toHaveBeenCalledWith('read', huge, 'tu_1')
  })

  it('el tope por default deja pasar un resultado normal', async () => {
    const { provider, requests } = readThenFinish()
    const normal = 'y'.repeat(50_000)

    await provider.run(ctxFor({ tools: [readTool(normal)] }))

    const result = lastToolResult(requests[1]?.body)
    expect(result?.content).toBe(normal)
  })
})

describe('parseAnthropicAgentConfig — contexto', () => {
  it('acepta clearToolUses booleano u objeto, y maxToolResultChars', () => {
    expect(
      parseAnthropicAgentConfig({
        clearToolUses: { triggerTokens: 80_000, excludeTools: ['a'] },
        maxToolResultChars: 40_000,
      }),
    ).toEqual({
      clearToolUses: { triggerTokens: 80_000, excludeTools: ['a'] },
      maxToolResultChars: 40_000,
    })
    expect(parseAnthropicAgentConfig({ clearToolUses: false })).toEqual({ clearToolUses: false })
  })

  it.each([
    { clearToolUses: { trigger: 1 } },
    { clearToolUses: { keepToolUses: 0 } },
    { clearToolUses: { excludeTools: 'a' } },
    { clearToolUses: 'yes' },
    { maxToolResultChars: 0 },
  ])('rechaza %j', (raw) => {
    expect(() => parseAnthropicAgentConfig(raw)).toThrow(/valor inválido/)
  })
})

describe('AnthropicProvider — respuestas vacías', () => {
  const empty = { content: [], stop_reason: 'tool_use' }
  const done = { content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' }

  function replying(...bodies: unknown[]) {
    const sent: Array<{ messages: unknown[] }> = []
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string))
      return jsonResponse(bodies[Math.min(sent.length - 1, bodies.length - 1)])
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { provider, sent }
  }

  it('un turno sin bloques no entra a la conversación: se repite el mismo request', async () => {
    const { provider, sent } = replying(empty, done)

    const result = await provider.run(ctxFor())

    expect(result).toEqual({ outcome: 'success', summary: 'listo' })
    expect(sent).toHaveLength(2)
    expect(sent[1]?.messages).toEqual(sent[0]?.messages)
  })

  it('después de dos reintentos vacíos seguidos, falla diciendo por qué', async () => {
    const { provider, sent } = replying(empty)

    await expect(provider.run(ctxFor())).rejects.toThrow(/3 respuestas vacías seguidas/)
    expect(sent).toHaveLength(3)
  })
})
