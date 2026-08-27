import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { registerTool, setAgentMemoryPort } from '@ia-flow/tools'
import { createMcpRouter } from '../mcp.js'

registerTool({
  name: 'mcp_test_echo',
  description: 'Echoes its input back — test-only tool.',
  input_schema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
  providerKinds: ['async'],
  async execute(input: unknown) {
    return `echo: ${(input as { value: string }).value}`
  },
})

registerTool({
  name: 'mcp_test_sync_only',
  description: 'Sync-only tool — should never appear in tools/list here.',
  input_schema: { type: 'object', properties: {} },
  providerKinds: ['sync'],
  async execute() {
    return 'should not be called'
  },
})

registerTool({
  name: 'mcp_test_throws',
  description: 'Always throws — test-only tool.',
  input_schema: { type: 'object', properties: {} },
  providerKinds: ['async'],
  async execute() {
    throw new Error('boom')
  },
})

describe('POST /api/mcp', () => {
  const app = createMcpRouter()

  const rpc = (body: unknown, query = '') =>
    app.request(`/${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('returns a parse error for invalid JSON', async () => {
    const res = await rpc('not json')
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { code: number } }
    expect(json.error.code).toBe(-32700)
  })

  it('initialize responds with protocol info and tools capability', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      id: number
      result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: object }
    }
    expect(json.id).toBe(1)
    expect(json.result.capabilities.tools).toEqual({})
    expect(json.result.serverInfo).toMatchObject({ name: 'ia-flow-tools' })
  })

  it('notifications/initialized returns 202 with no body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    const text = await res.text()
    expect(text).toBe('')
  })

  it('tools/list scopes to the ?tools= query param and excludes sync-only tools', async () => {
    const res = await rpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      '?tools=mcp_test_echo,mcp_test_sync_only',
    )
    const json = (await res.json()) as {
      result: { tools: Array<{ name: string; inputSchema: object }> }
    }
    const names = json.result.tools.map((t) => t.name)
    expect(names).toContain('mcp_test_echo')
    // Sync-only tool must never leak into the async MCP tool list, even when
    // explicitly named in ?tools= — providerKind is the hard gate.
    expect(names).not.toContain('mcp_test_sync_only')
  })

  it('tools/list with no ?tools= still respects the async providerKind filter', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
    const json = (await res.json()) as { result: { tools: Array<{ name: string }> } }
    const names = json.result.tools.map((t) => t.name)
    expect(names).not.toContain('mcp_test_sync_only')
  })

  it('tools/call executes the tool and wraps the result as text content', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'mcp_test_echo', arguments: { value: 'hi' } },
    })
    const json = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }>; isError?: boolean }
    }
    expect(json.result.isError).toBeUndefined()
    expect(json.result.content).toEqual([{ type: 'text', text: 'echo: hi' }])
  })

  it('tools/call returns isError:true (not an HTTP error) for an unknown tool', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} },
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('not found')
  })

  it('tools/call returns isError:true when the tool throws', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'mcp_test_throws', arguments: {} },
    })
    const json = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean }
    }
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toBe('boom')
  })

  it('tools/call with a missing name returns a JSON-RPC error', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} })
    const json = (await res.json()) as { error: { code: number } }
    expect(json.error.code).toBe(-32602)
  })

  it('rejects an unknown method with 404 and a JSON-RPC error', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 8, method: 'nope' })
    expect(res.status).toBe(404)
    const json = (await res.json()) as { error: { code: number; message: string } }
    expect(json.error.code).toBe(-32601)
    expect(json.error.message).toContain('nope')
  })
})

// El namespace de las tools `memory_*` viaja en la conexión (`?agent=`,
// `?project=`), no en los argumentos de la llamada. Estos tests recorren ese
// camino completo — URL → ctx → tool → port — con un port falso, para no
// escribir en la SQLite real del operador.
describe('POST /api/mcp — namespace de las memory tools', () => {
  const app = createMcpRouter()
  const TOOLS = 'memory_store,memory_retrieve'

  let stored: Array<{ agentId: string; projectId: string; key: string; value: string }>

  const rpc = (body: unknown, query: string) =>
    app.request(`/?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const text = async (res: Response) => {
    const json = (await res.json()) as { result: { content: Array<{ text: string }> } }
    return json.result.content[0].text
  }

  const store = (query: string, key: string, value: string) =>
    rpc(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'memory_store', arguments: { key, value } },
      },
      query,
    )

  const retrieve = (query: string, key: string) =>
    rpc(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory_retrieve', arguments: { key } },
      },
      query,
    )

  beforeEach(() => {
    stored = []
    setAgentMemoryPort({
      async get(agentId, projectId, key) {
        const hit = stored.find(
          (e) => e.agentId === agentId && e.projectId === projectId && e.key === key,
        )
        return hit ? { ...hit, updatedAt: '2026-08-27T00:00:00.000Z' } : null
      },
      async list() {
        return []
      },
      async search() {
        return []
      },
      async upsert(entry) {
        stored.push({
          agentId: entry.agentId,
          projectId: entry.projectId,
          key: entry.key,
          value: entry.value,
        })
      },
      async deleteByKey() {
        return false
      },
    })
  })

  afterEach(() => {
    setAgentMemoryPort(null)
  })

  it('lo guardado en una conexión se recupera en la siguiente del mismo agente', async () => {
    const query = `tools=${TOOLS}&agent=builder&project=p1`
    await store(query, 'last_pr_number', '42')
    // Otra request = otro run: lo único que persiste es el store.
    expect(await text(await retrieve(query, 'last_pr_number'))).toBe('42')
  })

  it('el agente sale de la URL, no de los argumentos — dos agentes no se pisan', async () => {
    await store(`tools=${TOOLS}&agent=builder&project=p1`, 'nota', 'del builder')
    await store(`tools=${TOOLS}&agent=reviewer&project=p1`, 'nota', 'del reviewer')

    expect(stored.map((e) => e.agentId).sort()).toEqual(['builder', 'reviewer'])
    expect(await text(await retrieve(`tools=${TOOLS}&agent=builder&project=p1`, 'nota'))).toBe(
      'del builder',
    )
    expect(await text(await retrieve(`tools=${TOOLS}&agent=reviewer&project=p1`, 'nota'))).toBe(
      'del reviewer',
    )
  })

  it('sin ?agent= la tool rechaza en vez de escribir en un namespace adivinado', async () => {
    const out = await text(await store(`tools=${TOOLS}&project=p1`, 'k', 'v'))
    expect(out).toMatch(/no informó qué agente/)
    expect(stored).toHaveLength(0)
  })

  it('un agente cuyo ?tools= no incluye memory_* no las ve ni las puede llamar', async () => {
    const query = 'tools=mcp_test_echo&agent=builder&project=p1'

    const list = (await (
      await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, query)
    ).json()) as { result: { tools: Array<{ name: string }> } }
    expect(list.result.tools.map((t) => t.name)).not.toContain('memory_store')

    const called = (await (await store(query, 'k', 'v')).json()) as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    expect(called.result.isError).toBe(true)
    expect(called.result.content[0].text).toContain('not found')
    expect(stored).toHaveLength(0)
  })
})
