import { afterEach, describe, expect, it } from 'bun:test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type McpHost, type McpHostEntry, startMcpHost } from '../mcp/mcpHost.js'

/** Un proceso de mentira: no sale hasta que lo matan, o sale ya con `exitAfterMs`. */
function fakeSpawn(calls: string[][], exitAfterMs?: number) {
  return (command: string[]) => {
    calls.push(command)
    let kill = () => {}
    const exited = new Promise<number>((resolve) => {
      kill = () => resolve(143)
      if (exitAfterMs !== undefined) setTimeout(() => resolve(1), exitAfterMs)
    })
    return { exited, kill: () => kill() }
  }
}

let upstream: ReturnType<typeof Bun.serve> | undefined
let server: Server | undefined
let host: McpHost | undefined

afterEach(async () => {
  host?.close()
  host = undefined
  upstream?.stop(true)
  upstream = undefined
  server?.closeAllConnections()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
  delete process.env.TEST_MCP_TOKEN
})

/** El MCP de verdad (loopback): repite método, path, body y headers; `/sse` contesta un stream. */
function startUpstream() {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/mcp/sse') {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: uno\n\n'))
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode('data: dos\n\n'))
              controller.close()
            }, 20)
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json(
        {
          method: req.method,
          path: url.pathname + url.search,
          body: req.method === 'GET' ? null : await req.text(),
          authorization: req.headers.get('authorization'),
        },
        { headers: { 'mcp-session-id': 's-1' } },
      )
    },
  })
  return `http://127.0.0.1:${upstream.port}/mcp`
}

async function start(entries: Record<string, McpHostEntry>, calls: string[][] = []) {
  const logs: string[] = []
  host = await startMcpHost(entries, {
    log: (line) => logs.push(line),
    spawn: fakeSpawn(calls),
    restartDelayMs: 1,
  })
  const mounted = host
  server = createServer((req, res) => {
    void mounted.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(418).end()
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, logs }
}

const entry = (upstreamUrl: string, extra: Partial<McpHostEntry> = {}): McpHostEntry => ({
  command: ['figma-developer-mcp', '--port', '3333'],
  upstream: upstreamUrl,
  token: '${TEST_MCP_TOKEN}',
  ...extra,
})

describe('mcpHost', () => {
  it('forwards /mcp/<id> to its upstream with the bearer checked and dropped', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    const calls: string[][] = []
    const { base } = await start({ figma: entry(startUpstream()) }, calls)
    expect(calls).toEqual([['figma-developer-mcp', '--port', '3333']])

    const res = await fetch(`${base}/mcp/figma/messages?x=1`, {
      method: 'POST',
      headers: { authorization: 'Bearer secreto', 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('mcp-session-id')).toBe('s-1')
    expect(await res.json()).toEqual({
      method: 'POST',
      path: '/mcp/messages?x=1',
      body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      authorization: null,
    })
  })

  it('rejects a missing or wrong bearer with 401', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    const { base } = await start({ figma: entry(startUpstream()) })
    expect((await fetch(`${base}/mcp/figma`, { method: 'POST' })).status).toBe(401)
    const wrong = await fetch(`${base}/mcp/figma`, {
      method: 'POST',
      headers: { authorization: 'Bearer otro' },
    })
    expect(wrong.status).toBe(401)
  })

  it('fails closed without its token: 503 and the process is never launched', async () => {
    const calls: string[][] = []
    const { base, logs } = await start({ figma: entry(startUpstream()) }, calls)
    expect(calls).toEqual([])
    expect(host?.ids).toEqual([])
    expect(logs.some((line) => line.includes('sin token'))).toBe(true)
    const res = await fetch(`${base}/mcp/figma`, {
      method: 'POST',
      headers: { authorization: 'Bearer secreto' },
    })
    expect(res.status).toBe(503)
  })

  it('answers 404 for an unknown id and leaves other paths to the next handler', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    const { base } = await start({ figma: entry(startUpstream()) })
    expect((await fetch(`${base}/mcp/otro`)).status).toBe(404)
    expect((await fetch(`${base}/api/tasks`)).status).toBe(418)
  })

  it('streams an SSE response instead of buffering it', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    const { base } = await start({ figma: entry(startUpstream()) })
    const res = await fetch(`${base}/mcp/figma/sse`, {
      headers: { authorization: 'Bearer secreto', accept: 'text/event-stream' },
    })
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    expect(await res.text()).toBe('data: uno\n\ndata: dos\n\n')
  })

  it('answers 502 when its process is not listening', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    const { base } = await start({ figma: entry('http://127.0.0.1:1/mcp') })
    const res = await fetch(`${base}/mcp/figma`, {
      method: 'POST',
      headers: { authorization: 'Bearer secreto' },
    })
    expect(res.status).toBe(502)
  })

  it('exposes the local upstream of a published id and waits for it to answer', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    const url = startUpstream()
    await start({ figma: entry(url) })
    expect(host?.upstreamOf('figma')).toBe(url)
    expect(host?.upstreamOf('otro')).toBeUndefined()
    await host?.ready(1_000)
  })

  it('relaunches a process that exits and gives up after five fast exits', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    const calls: string[][] = []
    const logs: string[] = []
    host = await startMcpHost(
      { figma: entry('http://127.0.0.1:1/mcp') },
      { log: (line) => logs.push(line), spawn: fakeSpawn(calls, 1), restartDelayMs: 1 },
    )
    const deadline = Date.now() + 2_000
    while (!logs.some((line) => line.includes('queda caído')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(calls).toHaveLength(5)
    expect(logs.some((line) => line.includes('queda caído'))).toBe(true)
  })

  it('passes its env, with ${VAR} resolved, to the process', async () => {
    process.env.TEST_MCP_TOKEN = 'secreto'
    let seen: Record<string, string | undefined> = {}
    host = await startMcpHost(
      {
        memory: entry('http://127.0.0.1:1/mcp', {
          env: { MEMORY_FILE_PATH: '/state/memory.json', COPY: '${TEST_MCP_TOKEN}' },
        }),
      },
      {
        log: () => {},
        spawn: (_command, env) => {
          seen = env
          return { exited: new Promise(() => {}), kill: () => {} }
        },
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(seen.MEMORY_FILE_PATH).toBe('/state/memory.json')
    expect(seen.COPY).toBe('secreto')
  })
})
