import { describe, expect, it } from 'vitest'
import { MCP_PROTOCOL_VERSION, McpError, McpHttpClient } from '../McpHttpClient.js'
import { fakeMcpServer } from './fakeMcpServer.js'

const URL = 'https://mcp.test/mcp'

describe('McpHttpClient', () => {
  it('inicializa una vez, reenvía la sesión y lista las tools', async () => {
    const server = fakeMcpServer({ tools: [{ name: 'get_me', description: 'el usuario' }] })
    const client = new McpHttpClient({ url: URL, fetchImpl: server.fetchImpl })

    expect(await client.listTools()).toEqual([
      {
        name: 'get_me',
        description: 'el usuario',
        inputSchema: { type: 'object', properties: {} },
      },
    ])
    await client.listTools()

    expect(server.seen.map((r) => r.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'tools/list',
    ])
    const list = server.seen[2]
    expect(list?.headers['mcp-session-id']).toBe('s1')
    expect(list?.headers['mcp-protocol-version']).toBe(MCP_PROTOCOL_VERSION)
    expect(list?.headers.accept).toBe('application/json, text/event-stream')
  })

  it('sigue la paginación de tools/list', async () => {
    const tools = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name }))
    const server = fakeMcpServer({ tools, pageSize: 2 })
    const client = new McpHttpClient({ url: URL, fetchImpl: server.fetchImpl })

    expect((await client.listTools()).map((t) => t.name)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(server.seen.filter((r) => r.method === 'tools/list')).toHaveLength(3)
  })

  it('lee las respuestas que vienen en SSE', async () => {
    const server = fakeMcpServer({
      sse: true,
      tools: [
        { name: 'echo', call: (args) => ({ content: [{ type: 'text', text: String(args.v) }] }) },
      ],
    })
    const client = new McpHttpClient({ url: URL, fetchImpl: server.fetchImpl })

    expect(await client.callTool('echo', { v: 'hola' })).toEqual({ text: 'hola', isError: false })
  })

  it('aplana el content a texto y marca isError', async () => {
    const server = fakeMcpServer({
      tools: [
        {
          name: 'mixed',
          call: () => ({
            content: [
              { type: 'text', text: 'uno' },
              { type: 'image', mimeType: 'image/png', data: 'x' },
              { type: 'resource', resource: { uri: 'file://a', text: 'dos' } },
            ],
          }),
        },
        {
          name: 'fails',
          call: () => ({ isError: true, content: [{ type: 'text', text: 'Bad credentials' }] }),
        },
        { name: 'structured', call: () => ({ content: [], structuredContent: { login: 'x' } }) },
      ],
    })
    const client = new McpHttpClient({ url: URL, fetchImpl: server.fetchImpl })

    expect(await client.callTool('mixed', {})).toEqual({
      text: 'uno\n[image image/png]\ndos',
      isError: false,
    })
    expect(await client.callTool('fails', {})).toEqual({ text: 'Bad credentials', isError: true })
    expect((await client.callTool('structured', {})).text).toBe('{"login":"x"}')
  })

  it('resuelve el token en cada request cuando es una función', async () => {
    let n = 0
    const server = fakeMcpServer({ tools: [{ name: 'a' }] })
    const client = new McpHttpClient({
      url: URL,
      fetchImpl: server.fetchImpl,
      authorizationToken: () => `t${++n}`,
    })

    await client.listTools()
    expect(server.seen.map((r) => r.headers.authorization)).toEqual([
      'Bearer t1',
      'Bearer t2',
      'Bearer t3',
    ])
  })

  it('con un token renovable, un 401 pide uno nuevo (force) y reintenta una vez', async () => {
    const server = fakeMcpServer({ tools: [{ name: 'a' }], token: 'nuevo' })
    const forced: boolean[] = []
    const client = new McpHttpClient({
      url: URL,
      fetchImpl: server.fetchImpl,
      authorizationToken: ({ force = false } = {}) => {
        forced.push(force)
        return force || forced.length > 1 ? 'nuevo' : 'vencido'
      },
    })

    expect((await client.listTools()).map((t) => t.name)).toEqual(['a'])
    expect(server.seen[0]?.headers.authorization).toBe('Bearer vencido')
    expect(server.seen[1]?.headers.authorization).toBe('Bearer nuevo')
    expect(forced.slice(0, 2)).toEqual([false, true])
  })

  it('abre otra sesión si el servidor olvidó la suya (404)', async () => {
    const server = fakeMcpServer({ tools: [{ name: 'a' }] })
    const client = new McpHttpClient({ url: URL, fetchImpl: server.fetchImpl })
    await client.listTools()
    server.forgetSession()

    expect((await client.listTools()).map((t) => t.name)).toEqual(['a'])
    expect(server.seen.filter((r) => r.method === 'initialize')).toHaveLength(2)
  })

  it('un error HTTP o JSON-RPC es un McpError con el detalle', async () => {
    const down = fakeMcpServer({ tools: [], initializeStatus: 503 })
    await expect(
      new McpHttpClient({ url: URL, fetchImpl: down.fetchImpl }).listTools(),
    ).rejects.toThrow(new McpError('initialize → HTTP 503: down'))

    const unauthorized = fakeMcpServer({ tools: [], token: 'ok' })
    await expect(
      new McpHttpClient({
        url: URL,
        fetchImpl: unauthorized.fetchImpl,
        authorizationToken: 'mal',
      }).listTools(),
    ).rejects.toThrow('initialize → HTTP 401')

    const server = fakeMcpServer({ tools: [] })
    await expect(
      new McpHttpClient({ url: URL, fetchImpl: server.fetchImpl }).callTool('nope', {}),
    ).rejects.toThrow('tools/call: unknown tool')
  })

  it('un initialize fallido se reintenta en la próxima llamada', async () => {
    let fail = true
    const server = fakeMcpServer({ tools: [{ name: 'a' }] })
    const flaky = (async (url: string, init?: RequestInit) => {
      if (fail) {
        fail = false
        return new Response('down', { status: 503 })
      }
      return server.fetchImpl(url, init)
    }) as typeof fetch
    const client = new McpHttpClient({ url: URL, fetchImpl: flaky })

    await expect(client.listTools()).rejects.toThrow('HTTP 503')
    expect((await client.listTools()).map((t) => t.name)).toEqual(['a'])
  })
})
