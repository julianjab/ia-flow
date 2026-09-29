import type {
  EventBus,
  PipelineExecutionContext,
  ProviderRunContext,
  Tool,
} from '@ia-flow/agent-engine'
import { createEvent } from '@ia-flow/agent-engine'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicProvider, parseAnthropicAgentConfig } from '../AnthropicProvider.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
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

describe('AnthropicProvider.run', () => {
  it('returns success with the final text on end_turn', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' }),
    )
    const provider = new AnthropicProvider({
      id: 'anthropic-api',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor())

    expect(result).toEqual({ outcome: 'success', summary: 'listo' })
  })

  it('resolveOutcome overrides the default success outcome', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'actionable' }], stop_reason: 'end_turn' }),
    )
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      resolveOutcome: (text) => text,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor())

    expect(result.outcome).toBe('actionable')
  })

  it('returns truncated (no bump) when bumpMaxTokensOnTruncation is false', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }),
    )
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      bumpMaxTokensOnTruncation: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor())

    expect(result).toEqual({ outcome: 'truncated', summary: 'partial' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('bumps max_tokens once on truncation and succeeds if the retry converges', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++
      const body = JSON.parse(init.body as string)
      if (calls === 1) {
        expect(body.max_tokens).toBe(1000)
        return jsonResponse({
          content: [{ type: 'text', text: 'cut' }],
          stop_reason: 'max_tokens',
        })
      }
      expect(body.max_tokens).toBe(2000)
      return jsonResponse({ content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      maxTokens: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor())

    expect(result).toEqual({ outcome: 'success', summary: 'done' })
    expect(calls).toBe(2)
  })

  it('runs a tool_use round trip and feeds tool_result back', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++
      const body = JSON.parse(init.body as string)
      if (calls === 1) {
        expect(body.tools).toEqual([{ name: 'add', description: 'suma', input_schema: {} }])
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'add', input: { a: 1, b: 2 } }],
          stop_reason: 'tool_use',
        })
      }
      // Segunda vuelta: el tool_result tiene que estar en el último mensaje user.
      const lastMessage = body.messages[body.messages.length - 1]
      expect(lastMessage).toEqual({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '3' }],
      })
      return jsonResponse({
        content: [{ type: 'text', text: 'suma: 3' }],
        stop_reason: 'end_turn',
      })
    })

    const tool: Tool = {
      name: 'add',
      description: 'suma',
      inputSchema: {},
      handler: (input: { a: number; b: number }) => String(input.a + input.b),
    }
    const onToolCall = vi.fn()
    const onToolResult = vi.fn()
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      onToolCall,
      onToolResult,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor({ tools: [tool] }))

    expect(result).toEqual({ outcome: 'success', summary: 'suma: 3' })
    expect(onToolCall).toHaveBeenCalledWith('add', { a: 1, b: 2 }, 'tu_1')
    expect(onToolResult).toHaveBeenCalledWith('add', '3', 'tu_1')
  })

  it('reports an unknown tool name as an is_error tool_result instead of throwing', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'missing', input: {} }],
          stop_reason: 'tool_use',
        })
      }
      const body = JSON.parse(init.body as string)
      const lastMessage = body.messages[body.messages.length - 1]
      expect(lastMessage.content[0].is_error).toBe(true)
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor())

    expect(result.outcome).toBe('success')
  })

  it('reports a throwing tool handler as an is_error tool_result instead of crashing the run', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'boom', input: {} }],
          stop_reason: 'tool_use',
        })
      }
      const body = JSON.parse(init.body as string)
      const lastMessage = body.messages[body.messages.length - 1]
      expect(lastMessage.content[0]).toMatchObject({ is_error: true, content: 'Error: kaboom' })
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const tool: Tool = {
      name: 'boom',
      description: 'd',
      inputSchema: {},
      handler: () => {
        throw new Error('kaboom')
      },
    }
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor({ tools: [tool] }))

    expect(result.outcome).toBe('success')
  })

  it('throws on an unexpected stop_reason instead of guessing success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ content: [], stop_reason: null }))
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.run(ctxFor())).rejects.toThrow('null')
  })

  it('resends the conversation and continues on pause_turn instead of throwing', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      calls++
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'text', text: 'a mitad' }],
          stop_reason: 'pause_turn',
        })
      }
      const body = JSON.parse(init.body as string)
      const lastMessage = body.messages[body.messages.length - 1]
      expect(lastMessage).toEqual({
        role: 'assistant',
        content: [{ type: 'text', text: 'a mitad' }],
      })
      return jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const result = await provider.run(ctxFor())

    expect(result).toEqual({ outcome: 'success', summary: 'listo' })
    expect(calls).toBe(2)
  })

  it('throws once maxToolRounds is exceeded without converging', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'noop', input: {} }],
        stop_reason: 'tool_use',
      }),
    )
    const tool: Tool = { name: 'noop', description: 'd', inputSchema: {}, handler: () => 'x' }
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      maxToolRounds: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await expect(provider.run(ctxFor({ tools: [tool] }))).rejects.toThrow('maxToolRounds')
  })

  it('clamps a provider-level thinking budget under maxTokens instead of sending it as-is', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      // budgetTokens (8192) is bigger than maxTokens (4096) — an unclamped value would violate
      // the API's budget_tokens < max_tokens requirement and 400.
      expect(body.max_tokens).toBe(4096)
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 3072 })
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      maxTokens: 4096,
      thinking: { type: 'enabled', budgetTokens: 8192 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(ctxFor())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('omits thinking entirely when even a clamped budget cannot fit under maxTokens', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      // Default maxTokens is 1024 — the API requires budget_tokens >= 1024 AND < max_tokens, so
      // no budget fits. Silently omitting thinking (not sending an invalid request) is correct.
      expect(body.max_tokens).toBe(1024)
      expect(body.thinking).toBeUndefined()
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      thinking: { type: 'enabled', budgetTokens: 2048 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(ctxFor())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('passes an adaptive provider-level thinking config through unchanged', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.thinking).toEqual({ type: 'adaptive' })
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      thinking: { type: 'adaptive' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(ctxFor())

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('resolves a function MCP token on every request, so an expiring token is never stale', async () => {
    let issued = 0
    const seen: string[] = []
    let round = 0
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      seen.push(body.mcp_servers[0].authorization_token)
      round++
      return round === 1
        ? jsonResponse({
            content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }],
            stop_reason: 'tool_use',
          })
        : jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(
      ctxFor({
        tools: [
          { name: 'echo', description: 'e', inputSchema: { type: 'object' }, handler: () => 'x' },
        ],
        mcpServers: [
          {
            id: 'gh',
            config: {
              url: 'https://mcp.example/gh',
              authorizationToken: async () => `tok-${++issued}`,
            },
          },
        ],
      }),
    )

    expect(seen).toEqual(['tok-1', 'tok-2'])
  })

  it('builds mcp_servers from McpServerRef config and defers its tools by default', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.mcp_servers).toEqual([
        { name: 'gh', type: 'url', url: 'https://mcp.example/gh', authorization_token: 'tok' },
      ])
      expect(body.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_search_tool_regex_20251119' }),
          expect.objectContaining({ type: 'mcp_toolset', mcp_server_name: 'gh' }),
        ]),
      )
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(
      ctxFor({
        mcpServers: [
          { id: 'gh', config: { url: 'https://mcp.example/gh', authorizationToken: 'tok' } },
        ],
      }),
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('calls onCheckpoint with the running conversation before each request', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async () => {
      calls++
      if (calls === 1) {
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'noop', input: {} }],
          stop_reason: 'tool_use',
        })
      }
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const tool: Tool = { name: 'noop', description: 'd', inputSchema: {}, handler: () => 'x' }
    const onCheckpoint = vi.fn()
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      onCheckpoint,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(ctxFor({ tools: [tool] }))

    expect(onCheckpoint).toHaveBeenCalledTimes(2)
    expect((onCheckpoint.mock.calls[0][0] as unknown[]).length).toBe(1)
    expect((onCheckpoint.mock.calls[1][0] as unknown[]).length).toBe(3)
  })

  it('resumes from providerConfig.resumeMessages instead of the prompt', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.messages).toEqual([{ role: 'user', content: 'mensaje previo' }])
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(
      ctxFor({
        providerConfig: { resumeMessages: [{ role: 'user', content: 'mensaje previo' }] },
      }),
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('per-agent providerConfig overrides the provider-level model/maxTokens', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.model).toBe('claude-override')
      expect(body.max_tokens).toBe(50)
      return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
    })
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-default',
      maxTokens: 1000,
      apiKey: 'sk',
      stream: false,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await provider.run(ctxFor({ providerConfig: { model: 'claude-override', maxTokens: 50 } }))

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  describe('run config: same structure for the provider and each agent', () => {
    const toolUse = () =>
      jsonResponse({
        content: [{ type: 'tool_use', id: 'tu_1', name: 'noop', input: {} }],
        stop_reason: 'tool_use',
      })
    const noop: Tool = { name: 'noop', description: 'd', inputSchema: {}, handler: () => 'x' }
    const providerWith = (fetchImpl: unknown, extra: Record<string, unknown> = {}) =>
      new AnthropicProvider({
        id: 'x',
        model: 'claude-x',
        apiKey: 'sk',
        stream: false,
        fetchImpl: fetchImpl as typeof fetch,
        ...extra,
      })

    it('an agent can override maxToolRounds, like any other provider option', async () => {
      let calls = 0
      const fetchImpl = vi.fn(async () => {
        calls++
        return calls <= 3
          ? toolUse()
          : jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' })
      })
      // El provider sólo admite 1 vuelta; el agente pide 5 y converge en la 4ta respuesta.
      const provider = providerWith(fetchImpl, { maxToolRounds: 1 })

      const result = await provider.run(
        ctxFor({ tools: [noop], providerConfig: { maxToolRounds: 5 } }),
      )

      expect(result).toEqual({ outcome: 'success', summary: 'listo' })
      expect(calls).toBe(4)
    })

    it('an agent can also lower a provider option', async () => {
      const provider = providerWith(
        vi.fn(async () => toolUse()),
        { maxToolRounds: 50 },
      )
      await expect(
        provider.run(ctxFor({ tools: [noop], providerConfig: { maxToolRounds: 1 } })),
      ).rejects.toThrow('maxToolRounds (1)')
    })

    it('pause_turn has its own cap and does not spend tool rounds', async () => {
      let calls = 0
      const fetchImpl = vi.fn(async () => {
        calls++
        return calls <= 2
          ? jsonResponse({
              content: [{ type: 'text', text: 'a mitad' }],
              stop_reason: 'pause_turn',
            })
          : jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' })
      })
      const provider = providerWith(fetchImpl, { maxToolRounds: 1, maxPauseTurnRetries: 2 })

      expect(await provider.run(ctxFor())).toEqual({ outcome: 'success', summary: 'listo' })

      const paused = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'a mitad' }], stop_reason: 'pause_turn' }),
      )
      await expect(
        providerWith(paused).run(ctxFor({ providerConfig: { maxPauseTurnRetries: 1 } })),
      ).rejects.toThrow('maxPauseTurnRetries (1)')
      expect(paused).toHaveBeenCalledTimes(2)
    })

    it('maxPauseTurnRetries counts consecutive pauses: a tool round resets it', async () => {
      // pausa, tool, pausa, tool, pausa, fin: 3 pausas en total, nunca 2 seguidas.
      const script = ['pause', 'tool', 'pause', 'tool', 'pause', 'end']
      let calls = 0
      const fetchImpl = vi.fn(async () => {
        const step = script[calls++]
        if (step === 'pause') {
          return jsonResponse({
            content: [{ type: 'text', text: '…' }],
            stop_reason: 'pause_turn',
          })
        }
        if (step === 'tool') return toolUse()
        return jsonResponse({
          content: [{ type: 'text', text: 'listo' }],
          stop_reason: 'end_turn',
        })
      })
      const provider = providerWith(fetchImpl, { maxPauseTurnRetries: 1 })

      expect(await provider.run(ctxFor({ tools: [noop] }))).toEqual({
        outcome: 'success',
        summary: 'listo',
      })
      expect(calls).toBe(6)
    })

    it('an agent thinking replaces a provider thinkingBudgetTokens, and vice versa', async () => {
      const seen: unknown[] = []
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(JSON.parse(init.body as string).thinking)
        return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
      })
      const budgeted = providerWith(fetchImpl, { maxTokens: 8000, thinkingBudgetTokens: 4000 })
      await budgeted.run(ctxFor({ providerConfig: { thinking: { type: 'adaptive' } } }))

      const adaptive = providerWith(fetchImpl, { maxTokens: 8000, thinking: { type: 'adaptive' } })
      await adaptive.run(ctxFor({ providerConfig: { thinkingBudgetTokens: 2000 } }))

      expect(seen).toEqual([{ type: 'adaptive' }, { type: 'enabled', budget_tokens: 2000 }])
    })

    it('an agent thinking config replaces the provider one', async () => {
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        expect(JSON.parse(init.body as string).thinking).toEqual({ type: 'adaptive' })
        return jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
      })
      const provider = providerWith(fetchImpl, {
        maxTokens: 8000,
        thinking: { type: 'enabled', budgetTokens: 4000 },
      })

      await provider.run(ctxFor({ providerConfig: { thinking: { type: 'adaptive' } } }))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('rejects an unknown key or a wrong-typed value instead of ignoring it', () => {
      expect(() => parseAnthropicAgentConfig({ maxToolRound: 5 })).toThrow(
        /providerConfig\.maxToolRound: no es una opción de AnthropicProvider/,
      )
      expect(() => parseAnthropicAgentConfig({ maxToolRounds: '5' })).toThrow(
        /providerConfig\.maxToolRounds: valor inválido/,
      )
      expect(() => parseAnthropicAgentConfig({ effort: 'extreme' })).toThrow(/effort/)
      expect(() => parseAnthropicAgentConfig({ constructor: 1 })).toThrow(/no es una opción/)
      expect(
        parseAnthropicAgentConfig({ model: 'm', maxPauseTurnRetries: 0, effort: 'high' }),
      ).toEqual({ model: 'm', maxPauseTurnRetries: 0, effort: 'high' })
    })

    it('a run with an invalid providerConfig fails before calling the API', async () => {
      const fetchImpl = vi.fn()
      await expect(
        providerWith(fetchImpl).run(ctxFor({ providerConfig: { maxTokns: 10 } })),
      ).rejects.toThrow(/maxTokns/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })
  })

  describe('inbox (messages injected while the agent runs)', () => {
    const noop: Tool = { name: 'noop', description: 'd', inputSchema: {}, handler: () => 'x' }
    const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const provider = (responses: unknown[]) => {
      bodies.length = 0
      let call = 0
      return new AnthropicProvider({
        id: 'x',
        model: 'claude-x',
        apiKey: 'sk',
        stream: false,
        fetchImpl: vi.fn(async (_url: string, init: RequestInit) => {
          bodies.push(JSON.parse(init.body as string))
          return jsonResponse(responses[call++])
        }) as unknown as typeof fetch,
      })
    }
    const toolUse = {
      content: [{ type: 'tool_use', id: 'tu_1', name: 'noop', input: {} }],
      stop_reason: 'tool_use',
    }
    const done = { content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' }

    it('adds what arrived to the next user turn, after the tool results', async () => {
      const inbox = [[], ['Comentario de @julian: usá el enum']]
      await provider([toolUse, done]).run(
        ctxFor({ tools: [noop], inbox: () => inbox.shift() ?? [] }),
      )

      const turn = bodies[1]?.messages.at(-1)
      expect(turn?.role).toBe('user')
      expect(turn?.content).toEqual([
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'x' },
        {
          type: 'text',
          text: '[Mensaje recibido mientras trabajabas]\nComentario de @julian: usá el enum',
        },
      ])
    })

    it('joins a message that arrived before the first request to the prompt', async () => {
      await provider([done]).run(ctxFor({ inbox: () => ['antes de arrancar'] }))

      expect(bodies[0]?.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hola' },
            { type: 'text', text: '[Mensaje recibido mientras trabajabas]\nantes de arrancar' },
          ],
        },
      ])
    })

    it('keeps the inbox for later while a pause_turn continuation is pending', async () => {
      const paused = { content: [{ type: 'text', text: 'a mitad' }], stop_reason: 'pause_turn' }
      const inbox = vi.fn(() => ['llegó durante la pausa'])
      await provider([paused, done]).run(ctxFor({ inbox }))

      // La continuación del pause_turn sale con el asistente al final: sin inyectar ni vaciar.
      expect(bodies[1]?.messages.at(-1)?.role).toBe('assistant')
      expect(inbox).toHaveBeenCalledTimes(1)
    })
  })

  describe('terminal tools (submit_<exit>)', () => {
    const submit = (name: string, required: string[] = [], onCall = vi.fn()): Tool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {}, required },
      handler: (input: unknown) => {
        onCall(input)
        return 'ok'
      },
      terminal: true,
    })

    function providerWith(fetchImpl: unknown) {
      return new AnthropicProvider({
        id: 'x',
        model: 'claude-x',
        apiKey: 'sk',
        stream: false,
        fetchImpl: fetchImpl as typeof fetch,
      })
    }

    it('ends the turn as soon as a terminal tool succeeds, without another request', async () => {
      const onCall = vi.fn()
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          content: [
            { type: 'text', text: 'PRD listo' },
            { type: 'tool_use', id: 'tu_1', name: 'submit_done', input: { x: 1 } },
          ],
          stop_reason: 'tool_use',
        }),
      )

      const result = await providerWith(fetchImpl).run(
        ctxFor({ tools: [submit('submit_done', [], onCall), submit('submit_back')] }),
      )

      expect(result).toMatchObject({ outcome: 'success', summary: 'PRD listo' })
      // La conversación con los resultados de la vuelta: la que se retoma si fue una espera.
      expect((result.conversation as Array<{ role: string }>).map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
      ])
      expect(onCall).toHaveBeenCalledWith({ x: 1 })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('keeps looping when the terminal tool rejects its input, so the model can fix it', async () => {
      let calls = 0
      const rejecting: Tool = {
        ...submit('submit_done'),
        handler: () => {
          throw new Error('input inválido')
        },
      }
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        calls++
        if (calls === 1) {
          return jsonResponse({
            content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_done', input: {} }],
            stop_reason: 'tool_use',
          })
        }
        if (calls === 2) {
          const body = JSON.parse(init.body as string)
          expect(body.messages.at(-1).content[0]).toMatchObject({
            type: 'tool_result',
            is_error: true,
          })
        }
        return jsonResponse({
          content: [{ type: 'text', text: 'me rindo' }],
          stop_reason: 'end_turn',
        })
      })

      await providerWith(fetchImpl).run(ctxFor({ tools: [rejecting, submit('submit_back')] }))

      expect(fetchImpl).toHaveBeenCalledTimes(3) // rechazo → end_turn → una insistencia
    })

    it('nudges once when the model ends without calling any terminal tool', async () => {
      let calls = 0
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        calls++
        if (calls === 1) {
          return jsonResponse({
            content: [{ type: 'text', text: 'listo' }],
            stop_reason: 'end_turn',
          })
        }
        const body = JSON.parse(init.body as string)
        expect(body.messages.at(-1)).toEqual({
          role: 'user',
          content:
            'Para terminar tu turno tenés que llamar a una de estas tools: submit_done, submit_back.',
        })
        return jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_done', input: {} }],
          stop_reason: 'tool_use',
        })
      })

      const result = await providerWith(fetchImpl).run(
        ctxFor({ tools: [submit('submit_done'), submit('submit_back')] }),
      )

      expect(result.outcome).toBe('success')
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('nudges only once: a second end_turn returns and lets the Agent decide', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'no' }], stop_reason: 'end_turn' }),
      )

      const result = await providerWith(fetchImpl).run(
        ctxFor({ tools: [submit('submit_done'), submit('submit_back')] }),
      )

      expect(result).toEqual({ outcome: 'success', summary: 'no' })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('does not nudge for a single terminal tool that asks for no data', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'hola' }], stop_reason: 'end_turn' }),
      )

      await providerWith(fetchImpl).run(ctxFor({ tools: [submit('submit_done')] }))

      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('a failure tool (fail_turn) does not count towards nudging', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'hola' }], stop_reason: 'end_turn' }),
      )
      const fail: Tool = { ...submit('fail_turn', ['reason']), failure: true }

      await providerWith(fetchImpl).run(ctxFor({ tools: [submit('submit_done'), fail] }))

      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('a successful fail_turn ends the turn like any terminal tool', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'fail_turn', input: { reason: 'x' } }],
          stop_reason: 'tool_use',
        }),
      )
      const fail: Tool = { ...submit('fail_turn', ['reason']), failure: true }

      await providerWith(fetchImpl).run(ctxFor({ tools: [submit('submit_done'), fail] }))

      expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('nudges for a single terminal tool with required fields', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ content: [{ type: 'text', text: 'hola' }], stop_reason: 'end_turn' }),
      )

      await providerWith(fetchImpl).run(ctxFor({ tools: [submit('submit_done', ['report'])] }))

      expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
  })

  describe('resuming a conversation', () => {
    const provider = (fetchImpl: unknown) =>
      new AnthropicProvider({
        id: 'x',
        model: 'claude-x',
        apiKey: 'sk',
        stream: false,
        fetchImpl: fetchImpl as typeof fetch,
      })
    const endTurn = () =>
      jsonResponse({ content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' })
    const sentMessages = (fetchImpl: { mock: { calls: unknown[][] } }, call = 0) =>
      JSON.parse(String((fetchImpl.mock.calls[call]?.[1] as RequestInit | undefined)?.body))
        .messages

    it('starts from the conversation it is given, with the news in the last user turn', async () => {
      const fetchImpl = vi.fn(async () => endTurn())
      const conversation = [
        { role: 'user', content: 'hola' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'wait_for_event', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Esperando.' }],
        },
      ]

      await provider(fetchImpl).run(
        ctxFor({ resume: { conversation, message: 'Llegó el CI verde.' } }),
      )

      const messages = sentMessages(fetchImpl)
      expect(messages).toHaveLength(3)
      expect(messages[2].content).toEqual([
        { type: 'tool_result', tool_use_id: 't1', content: 'Esperando.' },
        { type: 'text', text: '[Mientras esperabas]\nLlegó el CI verde.' },
      ])
    })

    it('ignores a conversation that is not its own and starts from the prompt', async () => {
      const fetchImpl = vi.fn(async () => endTurn())
      await provider(fetchImpl).run(ctxFor({ resume: { conversation: 'otra cosa', message: 'x' } }))
      expect(sentMessages(fetchImpl)).toEqual([{ role: 'user', content: 'hola' }])
    })

    it('saves the conversation after every tool round', async () => {
      const saved: unknown[] = []
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }],
            stop_reason: 'tool_use',
          }),
        )
        .mockResolvedValueOnce(endTurn())
      const echo = {
        name: 'echo',
        description: 'e',
        inputSchema: { type: 'object' },
        handler: () => 'eco',
      }

      await provider(fetchImpl).run(
        ctxFor({ tools: [echo], saveConversation: (conversation) => saved.push(conversation) }),
      )

      expect(saved).toHaveLength(1)
      expect((saved[0] as Array<{ role: string }>).map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
      ])
    })
  })
})
