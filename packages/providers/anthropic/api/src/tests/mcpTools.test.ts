import { describe, expect, it } from 'vitest'
import { loadMcpTools, mcpEndpoints, mcpToolName } from '../mcpTools.js'
import { fakeMcpServer } from './fakeMcpServer.js'

describe('mcpEndpoints', () => {
  it('toma los que tienen URL, con el token de authorizationToken o del header Bearer', () => {
    const token = () => 'dinamico'
    expect(
      mcpEndpoints([
        { id: 'github', config: { url: 'https://gh/mcp', authorizationToken: token } },
        {
          id: 'figma',
          config: { url: 'https://figma/mcp', headers: { Authorization: 'Bearer fijo' } },
        },
        { id: 'abierto', config: { url: 'https://open/mcp' } },
        { id: 'stdio', config: { command: 'x' } },
      ]),
    ).toEqual([
      { id: 'github', url: 'https://gh/mcp', token },
      { id: 'figma', url: 'https://figma/mcp', token: 'fijo' },
      { id: 'abierto', url: 'https://open/mcp' },
    ])
  })
})

describe('mcpToolName', () => {
  it('prefija el servidor y reemplaza lo que la API no acepta', () => {
    expect(mcpToolName('github-mcp', 'get_me')).toBe('github-mcp__get_me')
    expect(mcpToolName('memory.mcp', 'read graph')).toBe('memory_mcp__read_graph')
  })

  it('corta los largos con un hash, sin que dos choquen', () => {
    const a = mcpToolName('github-mcp', `${'x'.repeat(70)}_a`)
    const b = mcpToolName('github-mcp', `${'x'.repeat(70)}_b`)
    expect(a).toHaveLength(64)
    expect(b).toHaveLength(64)
    expect(a).not.toBe(b)
  })
})

describe('loadMcpTools', () => {
  it('convierte las tools de cada servidor en tools que llaman al MCP', async () => {
    const github = fakeMcpServer({
      token: 'ghs',
      tools: [
        {
          name: 'get_me',
          description: 'El usuario autenticado',
          inputSchema: { type: 'object', properties: { verbose: { type: 'boolean' } } },
          call: (args) => ({ content: [{ type: 'text', text: `julianjab ${args.verbose}` }] }),
        },
      ],
    })
    const { tools, failures } = await loadMcpTools(
      [{ id: 'github-mcp', url: 'https://gh/mcp', token: 'ghs' }],
      { fetchImpl: github.fetchImpl },
    )

    expect(failures).toEqual([])
    expect(tools).toHaveLength(1)
    const [tool] = tools
    expect(tool?.name).toBe('github-mcp__get_me')
    expect(tool?.description).toBe('[github-mcp] El usuario autenticado')
    expect(tool?.inputSchema).toEqual({
      type: 'object',
      properties: { verbose: { type: 'boolean' } },
    })
    expect(await tool?.handler({ verbose: true })).toBe('julianjab true')
    expect(github.seen.at(-1)).toMatchObject({
      method: 'tools/call',
      params: { name: 'get_me', arguments: { verbose: true } },
    })
  })

  it('un isError del MCP hace tirar al handler, con el texto del servidor', async () => {
    const server = fakeMcpServer({
      tools: [
        {
          name: 'boom',
          call: () => ({ isError: true, content: [{ type: 'text', text: 'Not Found' }] }),
        },
      ],
    })
    const { tools } = await loadMcpTools([{ id: 's', url: 'https://s/mcp' }], {
      fetchImpl: server.fetchImpl,
    })
    await expect(tools[0]?.handler({})).rejects.toThrow('Not Found')
  })

  it('un servidor caído queda en failures y los demás cargan igual', async () => {
    const up = fakeMcpServer({ tools: [{ name: 'a' }] })
    const down = fakeMcpServer({ tools: [], initializeStatus: 502 })
    const fetchImpl = ((url: string, init?: RequestInit) =>
      (url.includes('down') ? down : up).fetchImpl(url, init)) as typeof fetch

    const { tools, failures } = await loadMcpTools(
      [
        { id: 'arriba', url: 'https://up/mcp' },
        { id: 'abajo', url: 'https://down/mcp' },
      ],
      { fetchImpl },
    )
    expect(tools.map((t) => t.name)).toEqual(['arriba__a'])
    expect(failures).toEqual([{ server: 'abajo', error: 'initialize → HTTP 502: down' }])
  })
})
