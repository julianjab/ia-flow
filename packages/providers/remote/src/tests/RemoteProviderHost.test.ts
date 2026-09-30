import { describe, expect, it } from 'vitest'
import type { RunRequest } from '../protocol.js'
import { call, delay, makeHost, ScriptedProvider, TOKEN } from './fixtures.js'

const BASE = 'http://host.test/v1'
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

function runRequest(overrides: Partial<RunRequest> = {}): RunRequest {
  return {
    agentId: 'implementer',
    prompt: 'hacé la tarea',
    systemPrompts: [],
    variables: {},
    providerConfig: {},
    mcpServers: [],
    tools: [{ name: 'read', description: 'lee', inputSchema: { type: 'object' } }],
    context: {
      event: { type: 'github.issues', payload: {}, occurredAt: '2026-09-29T00:00:00Z', depth: 0 },
      pipelineId: 'build',
    },
    hints: {},
    inbox: true,
    saveConversation: false,
    ...overrides,
  }
}

async function open(host: ReturnType<typeof makeHost>, body = runRequest()): Promise<string> {
  const res = await host.fetch(
    new Request(`${BASE}/providers/local/runs`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    }),
  )
  expect(res.status).toBe(202)
  return ((await res.json()) as { runId: string }).runId
}

async function sync(host: ReturnType<typeof makeHost>, runId: string, body: object) {
  const res = await host.fetch(
    new Request(`${BASE}/runs/${runId}/sync`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify(body),
    }),
  )
  return { status: res.status, body: (await res.json()) as { events: any[] } }
}

describe('RemoteProviderHost', () => {
  it('sin token configurado rechaza todo (nunca queda abierto por olvido)', async () => {
    const host = makeHost([], { token: undefined })
    const res = await host.fetch(new Request(`${BASE}/providers`, { headers: auth }))
    expect(res.status).toBe(500)
  })

  it('un token equivocado es 401', async () => {
    const host = makeHost([])
    const res = await host.fetch(
      new Request(`${BASE}/providers`, { headers: { authorization: 'Bearer otro' } }),
    )
    expect(res.status).toBe(401)
  })

  it('lista sus providers con lo que tienen corriendo', async () => {
    const host = makeHost([new ScriptedProvider('local', () => new Promise(() => {}), 3)])
    await open(host)
    const res = await host.fetch(new Request(`${BASE}/providers`, { headers: auth }))
    expect(await res.json()).toEqual({
      providers: [{ id: 'local', maxConcurrent: 3, running: 1 }],
    })
    host.close()
  })

  it('un provider desconocido es 404; un body inválido, 400', async () => {
    const host = makeHost([new ScriptedProvider('local', async () => ({ outcome: 'success' }))])
    const unknown = await host.fetch(
      new Request(`${BASE}/providers/otro/runs`, { method: 'POST', headers: auth, body: '{}' }),
    )
    expect(unknown.status).toBe(404)
    const invalid = await host.fetch(
      new Request(`${BASE}/providers/local/runs`, { method: 'POST', headers: auth, body: '{}' }),
    )
    expect(invalid.status).toBe(400)
  })

  it('al tope responde 503 con cuándo volver', async () => {
    const host = makeHost([new ScriptedProvider('local', () => new Promise(() => {}), 1)], {
      busyRetryMs: 5_000,
    })
    await open(host)
    const res = await host.fetch(
      new Request(`${BASE}/providers/local/runs`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(runRequest()),
      }),
    )
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('5')
    expect(await res.json()).toMatchObject({ accepting: false, retryAfterMs: 5_000 })
    host.close()
  })

  it('un sync reenviado no aplica dos veces ni el resultado ni el inbox', async () => {
    const inboxes: string[][] = []
    let result: unknown
    const local = new ScriptedProvider('local', async (ctx) => {
      result = await call(ctx, 'read')
      inboxes.push(ctx.inbox?.() ?? [])
      await delay(10)
      inboxes.push(ctx.inbox?.() ?? [])
      return { outcome: 'success' }
    })
    const host = makeHost([local])
    const runId = await open(host)
    const first = await sync(host, runId, { after: 0, waitMs: 200 })
    const toolCall = first.body.events[0]
    expect(toolCall).toMatchObject({ type: 'tool_call', name: 'read' })

    const again = {
      after: 0,
      results: [{ callId: toolCall.callId, text: 'contenido', isError: false }],
      inbox: ['hola'],
      inboxFrom: 0,
    }
    await sync(host, runId, again)
    // El mismo sync, reenviado (el anterior se cortó antes de volver).
    await sync(host, runId, again)
    const done = await sync(host, runId, { after: 1, inboxFrom: 1, waitMs: 500 })

    expect(result).toBe('contenido')
    expect(inboxes.flat()).toEqual(['hola'])
    expect(done.body.events.at(-1)).toMatchObject({ type: 'done', output: { outcome: 'success' } })
  })

  it('una corrida huérfana (el runner dejó de sincronizar) se corta: sus tools fallan', async () => {
    let failure: string | undefined
    const local = new ScriptedProvider('local', async (ctx) => {
      failure = await Promise.resolve(call(ctx, 'read')).catch((e: Error) => e.message)
      return { outcome: 'error' }
    })
    const host = makeHost([local], { orphanAfterMs: 1_000 })
    await open(host)
    await delay(10)

    host.sweep(Date.now() + 5_000)
    await delay(10)

    expect(failure).toBe('el runner dejó de sincronizar esta corrida')
    expect(host.running('local')).toBe(0)
  })

  it('olvida la que terminó y nadie vino a buscar', async () => {
    const host = makeHost([new ScriptedProvider('local', async () => ({ outcome: 'success' }))], {
      retainMs: 1_000,
    })
    const runId = await open(host)
    await delay(10)
    host.sweep(Date.now() + 5_000)
    expect((await sync(host, runId, { after: 0 })).status).toBe(404)
  })

  it('DELETE corta la corrida y la olvida', async () => {
    let failure: string | undefined
    const local = new ScriptedProvider('local', async (ctx) => {
      failure = await Promise.resolve(call(ctx, 'read')).catch((e: Error) => e.message)
      return { outcome: 'error' }
    })
    const host = makeHost([local])
    const runId = await open(host)
    await delay(10)
    const res = await host.fetch(
      new Request(`${BASE}/runs/${runId}`, { method: 'DELETE', headers: auth }),
    )
    await delay(10)
    expect(res.status).toBe(204)
    expect(failure).toBe('el runner canceló la corrida')
    expect((await sync(host, runId, { after: 0 })).status).toBe(404)
  })
})
