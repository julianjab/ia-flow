import type {
  EventBus,
  McpServerRef,
  PipelineExecutionContext,
  ProviderRunContext,
  Tool,
} from '@ia-flow/agent-engine'
import { createEvent } from '@ia-flow/agent-engine'
import { describe, expect, it, vi } from 'vitest'
import { AnthropicProvider, parseAnthropicAgentConfig } from '../AnthropicProvider.js'
import { fakeMcpServer } from './fakeMcpServer.js'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
}

function ctxFor(overrides: Partial<ProviderRunContext> = {}): ProviderRunContext {
  const ctx = {
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
    ctx,
    ...overrides,
  }
}

const own: Tool = {
  name: 'submit_done',
  description: 'cierra',
  inputSchema: {},
  handler: () => 'ok',
}
const github: McpServerRef = {
  id: 'github-mcp',
  config: { url: 'https://gh.test/mcp', authorizationToken: async () => 'ghs' },
}

/** La API falsa: anota cada body y header, y responde lo que le toca a cada vuelta. */
function anthropicApi(replies: unknown[]) {
  const bodies: Array<Record<string, unknown>> = []
  const betas: string[] = []
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    betas.push(new Headers(init.headers).get('anthropic-beta') ?? '')
    return jsonResponse(replies[bodies.length - 1])
  })
  return { fetchImpl: fetchImpl as unknown as typeof fetch, bodies, betas }
}

const done = { content: [{ type: 'text', text: 'listo' }], stop_reason: 'end_turn' }

describe('mcpTransport: client', () => {
  it('pasa las tools del MCP como tools diferidas, sin mcp_servers ni la beta del conector', async () => {
    const mcp = fakeMcpServer({
      token: 'ghs',
      tools: [{ name: 'get_me', description: 'el usuario' }],
    })
    const api = anthropicApi([done])
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      mcpTransport: 'client',
      fetchImpl: api.fetchImpl,
      mcpFetchImpl: mcp.fetchImpl,
    })

    await provider.run(ctxFor({ tools: [own], mcpServers: [github] }))

    const [body] = api.bodies
    expect(body?.mcp_servers).toBeUndefined()
    expect(api.betas[0]).not.toContain('mcp-client')
    expect(body?.tools).toEqual([
      { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' },
      { name: 'submit_done', description: 'cierra', input_schema: {} },
      {
        name: 'github-mcp__get_me',
        description: '[github-mcp] el usuario',
        input_schema: { type: 'object', properties: {} },
        defer_loading: true,
      },
    ])
  })

  it('un tool_use de una tool MCP llama al servidor y su resultado vuelve al modelo', async () => {
    const mcp = fakeMcpServer({
      tools: [{ name: 'get_me', call: () => ({ content: [{ type: 'text', text: 'julianjab' }] }) }],
    })
    const api = anthropicApi([
      {
        content: [{ type: 'tool_use', id: 't1', name: 'github-mcp__get_me', input: { a: 1 } }],
        stop_reason: 'tool_use',
      },
      done,
    ])
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: api.fetchImpl,
      mcpFetchImpl: mcp.fetchImpl,
    })

    const result = await provider.run(
      ctxFor({ mcpServers: [github], providerConfig: { mcpTransport: 'client' } }),
    )

    expect(result.outcome).toBe('success')
    expect(mcp.seen.at(-1)).toMatchObject({
      method: 'tools/call',
      params: { name: 'get_me', arguments: { a: 1 } },
    })
    const messages = api.bodies[1]?.messages as Array<{ role: string; content: unknown }>
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'julianjab' }],
    })
  })

  it('un MCP que no responde no tumba la corrida: el agente corre sin sus tools', async () => {
    const down = fakeMcpServer({ tools: [], initializeStatus: 502 })
    const api = anthropicApi([done])
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      mcpTransport: 'client',
      fetchImpl: api.fetchImpl,
      mcpFetchImpl: down.fetchImpl,
    })

    const result = await provider.run(ctxFor({ tools: [own], mcpServers: [github] }))

    expect(result.outcome).toBe('success')
    expect(api.bodies[0]?.tools).toEqual([
      { name: 'submit_done', description: 'cierra', input_schema: {} },
    ])
  })

  it('con eagerMcpTools no difiere ni agrega la búsqueda', async () => {
    const mcp = fakeMcpServer({ tools: [{ name: 'get_me' }] })
    const api = anthropicApi([done])
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      mcpTransport: 'client',
      eagerMcpTools: true,
      fetchImpl: api.fetchImpl,
      mcpFetchImpl: mcp.fetchImpl,
    })

    await provider.run(ctxFor({ mcpServers: [github] }))

    expect(api.bodies[0]?.tools).toEqual([
      {
        name: 'github-mcp__get_me',
        description: '[github-mcp] get_me',
        input_schema: { type: 'object', properties: {} },
      },
    ])
  })

  it('el default sigue siendo el conector', async () => {
    const api = anthropicApi([done])
    const provider = new AnthropicProvider({
      id: 'x',
      model: 'claude-x',
      apiKey: 'sk',
      stream: false,
      fetchImpl: api.fetchImpl,
    })

    await provider.run(ctxFor({ mcpServers: [github] }))

    expect(api.bodies[0]?.mcp_servers).toEqual([
      { name: 'github-mcp', type: 'url', url: 'https://gh.test/mcp', authorization_token: 'ghs' },
    ])
    expect(api.betas[0]).toContain('mcp-client-2025-11-20')
  })

  it('rechaza un mcpTransport desconocido', () => {
    expect(() => parseAnthropicAgentConfig({ mcpTransport: 'stdio' })).toThrow(
      'providerConfig.mcpTransport: valor inválido "stdio"',
    )
  })
})
