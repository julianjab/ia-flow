import type { Provider } from '@ia-flow/agent-engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../HostClient.js'
import type { HostTask } from '../protocol.js'
import {
  callTool,
  makeHost,
  makeHub,
  RUNNER,
  runContext,
  TOKEN,
  tool,
  until,
  wire,
} from './fixtures.js'

const hosts: HostClient[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
})
function started(host: HostClient): HostClient {
  hosts.push(host)
  host.start()
  return host
}

describe('suscripción', () => {
  it('un host suscrito aparece como remote:<name>; sin el token del runner, no', async () => {
    const { hub, registry } = makeHub()
    const res = await wire(hub)(`${RUNNER}/v1/hosts/subscribe`, {
      method: 'POST',
      headers: { authorization: 'Bearer otro' },
      body: JSON.stringify({ name: 'laptop' }),
    })
    expect(res.status).toBe(401)

    started(makeHost(hub, async () => undefined))
    await until(() => registry.resolve('remote:laptop') !== undefined)
    expect(hub.list()).toMatchObject([{ name: 'laptop', provider: 'remote:laptop', running: 0 }])
  })

  it('sin token configurado, la API de hosts responde 503 (nunca queda abierta)', async () => {
    const { hub } = makeHub({ token: undefined })
    const res = await wire(hub)(`${RUNNER}/v1/hosts/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ name: 'laptop' }),
    })
    expect(res.status).toBe(503)
  })

  it('un host que deja de pedir tareas se va: sale del registry y su corrida se pierde', async () => {
    let now = 1_000
    const { hub, registry } = makeHub({ now: () => now, leaseMs: 100 })
    const host = started(makeHost(hub, (_task, _runner, signal) => aborted(signal)))
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    const running = provider.run(
      runContext({ tools: [tool('submit_done', () => 'ok', { terminal: true })] }),
    )
    await until(() => host.running.length === 1)

    await host.stop()
    now += 1_000
    hub.sweep()

    expect(registry.resolve('remote:laptop')).toBeUndefined()
    expect(await running).toMatchObject({
      outcome: 'error',
      summary: expect.stringContaining('dejó de pedir tareas'),
    })
  })

  it('si el runner no lo conoce más (se reinició), el host se vuelve a suscribir solo', async () => {
    const first = makeHub()
    const second = makeHub()
    let hub = first.hub
    const host = started(
      new (await import('../HostClient.js')).HostClient({
        runnerUrl: RUNNER,
        token: TOKEN,
        name: 'laptop',
        maxConcurrent: 1,
        accepts: [],
        run: async () => undefined,
        fetchImpl: ((input: string | URL | Request, init?: RequestInit) =>
          wire(hub)(input, init)) as typeof fetch,
        retryMs: 10,
      }),
    )
    await until(() => first.registry.resolve('remote:laptop') !== undefined)
    hub = second.hub
    await until(() => second.registry.resolve('remote:laptop') !== undefined)
    expect(host.running).toEqual([])
  })
})

describe('una corrida', () => {
  it('el host la toma, el modelo llama la tool terminal por el MCP del runner y la corrida cierra', async () => {
    const { hub, registry } = makeHub()
    const seen: HostTask[] = []
    const ran = vi.fn(() => 'elegiste done')
    const host = started(
      makeHost(hub, async (task, runner, signal) => {
        seen.push(task)
        // La sesión allá: una tool del agente, y después cierra el turno.
        await callTool(hub, `${runner.base}${task.endpoints.mcp}`, 'submit_done', {
          summary: 'listo',
        })
        await aborted(signal)
        return undefined
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    expect(provider.workspace).toBe('native')

    const output = await provider.run(
      runContext({
        systemPrompts: ['sos el implementer'],
        providerConfig: { mode: 'tmux', model: 'opus' },
        tools: [
          tool('submit_done', ran, { terminal: true }),
          tool('fail_turn', () => 'x', { terminal: true, failure: true }),
        ],
      }),
    )

    expect(output).toMatchObject({
      outcome: 'success',
      conversation: { sessionId: seen[0]?.session.id },
    })
    expect(ran).toHaveBeenCalledWith({ summary: 'listo' })
    expect(seen[0]).toMatchObject({
      agentId: 'implementer',
      label: 'implementer-task-7',
      prompt: 'hacé la tarea',
      exits: ['submit_done'],
      providerConfig: { mode: 'tmux', model: 'opus' },
      event: { type: 'issue.status_changed', payload: { repo: 'eks', number: 7 } },
      session: { resume: false },
    })
    // El runner la cerró: el host cortó la sesión.
    await until(() => host.running.length === 0)
  })

  it('retoma la sesión que ya tenía, con lo que pasó mientras esperaba', async () => {
    const { hub, registry } = makeHub()
    const seen: HostTask[] = []
    started(
      makeHost(hub, async (task, runner, signal) => {
        seen.push(task)
        await callTool(hub, `${runner.base}${task.endpoints.mcp}`, 'submit_done')
        await aborted(signal)
        return undefined
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    await (registry.resolve('remote:laptop') as Provider).run(
      runContext({
        tools: [tool('submit_done', () => 'ok', { terminal: true })],
        resume: { conversation: { sessionId: 'sesion-1' }, message: 'el CI pasó' },
      }),
    )
    expect(seen[0]?.session).toEqual({ id: 'sesion-1', resume: true })
    expect(seen[0]?.prompt).toContain('el CI pasó')
  })

  it('una sesión que termina sin cerrar el turno es un error que dice por qué', async () => {
    const { hub, registry } = makeHub()
    started(makeHost(hub, async () => ({ status: 'exited', code: 1, message: 'se cayó' })))
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const output = await (registry.resolve('remote:laptop') as Provider).run(
      runContext({ tools: [tool('submit_done', () => 'ok', { terminal: true })] }),
    )
    expect(output).toMatchObject({
      outcome: 'error',
      summary: expect.stringContaining('terminó sin cerrar el turno (código 1): se cayó'),
    })
  })

  it('los hooks de la sesión llegan al canal: el Stop sin cerrar el turno insiste', async () => {
    const { hub, registry } = makeHub()
    const replies: unknown[] = []
    started(
      makeHost(hub, async (task, runner, signal) => {
        const res = await wire(hub)(`${runner.base}${task.endpoints.hooks}/Stop`, {
          method: 'POST',
          body: JSON.stringify({}),
        })
        replies.push(await res.json())
        await callTool(hub, `${runner.base}${task.endpoints.mcp}`, 'submit_done')
        await aborted(signal)
        return undefined
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    await (registry.resolve('remote:laptop') as Provider).run(
      runContext({ tools: [tool('submit_done', () => 'ok', { terminal: true })] }),
    )
    expect(replies[0]).toMatchObject({
      decision: 'block',
      reason: expect.stringContaining('submit_done'),
    })
  })
})

describe('transcripción', () => {
  const message = {
    id: 'msg_1',
    model: 'claude-opus',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    texts: ['listo'],
    sidechain: false,
  }

  it('los requests que el host lee de su transcripción llegan al canal de la corrida', async () => {
    const { hub, registry } = makeHub()
    const texts: string[] = []
    const statuses: number[] = []
    started(
      makeHost(hub, async (task, runner, signal) => {
        const url = `${runner.base}${task.endpoints.transcript}`
        const ok = await wire(hub)(url, {
          method: 'POST',
          body: JSON.stringify({ messages: [message] }),
        })
        const bad = await wire(hub)(url, { method: 'POST', body: JSON.stringify({ messages: 1 }) })
        statuses.push(ok.status, bad.status)
        await callTool(hub, `${runner.base}${task.endpoints.mcp}`, 'submit_done')
        await aborted(signal)
        return undefined
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    await (registry.resolve('remote:laptop') as Provider).run(
      runContext({
        tools: [tool('submit_done', () => 'ok', { terminal: true })],
        onText: (text: string) => texts.push(text),
      }),
    )
    expect(statuses).toEqual([200, 400])
    expect(texts).toEqual(['listo'])
  })

  it('una corrida desconocida es un 404', async () => {
    const { hub } = makeHub()
    const res = await wire(hub)(`${RUNNER}/v1/runs/nadie/transcript`, {
      method: 'POST',
      body: JSON.stringify({ messages: [message] }),
    })
    expect(res.status).toBe(404)
  })
})

describe('canAccept', () => {
  it('con las condiciones del host (el when de las pipelines) y su tope, sin ir al host', async () => {
    const { hub, registry } = makeHub()
    started(
      makeHost(hub, async () => undefined, {
        accepts: [
          { field: 'repo', op: 'in', value: ['eks', 'subscriptions'] },
          { field: 'agentId', op: 'neq', value: 'reviewer' },
        ],
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    const ctx = runContext().ctx

    expect(await provider.canAccept?.({ agentId: 'implementer', ctx })).toEqual({ accept: true })
    expect(await provider.canAccept?.({ agentId: 'reviewer', ctx })).toMatchObject({
      accept: false,
      reason: expect.stringContaining('agentId'),
    })
    const other = { ...ctx, event: { ...ctx.event, payload: { repo: 'web', number: 1 } } }
    expect(await provider.canAccept?.({ agentId: 'implementer', ctx: other })).toMatchObject({
      accept: false,
      reason: expect.stringContaining('repo'),
    })
  })

  it('al tope, no acepta hasta que termine la que corre', async () => {
    const { hub, registry } = makeHub()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    started(
      makeHost(hub, async (task, runner, signal) => {
        await gate
        await callTool(hub, `${runner.base}${task.endpoints.mcp}`, 'submit_done')
        await aborted(signal)
        return undefined
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    const first = provider.run(
      runContext({ tools: [tool('submit_done', () => 'ok', { terminal: true })] }),
    )
    await until(() => hub.list()[0]?.running === 1)

    expect(
      await provider.canAccept?.({ agentId: 'implementer', ctx: runContext().ctx }),
    ).toMatchObject({
      accept: false,
      reason: expect.stringContaining('al tope (1/1)'),
    })
    release()
    await first
    expect(await provider.canAccept?.({ agentId: 'implementer', ctx: runContext().ctx })).toEqual({
      accept: true,
    })
  })
})

function aborted(signal: AbortSignal): Promise<undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve(undefined)
    signal.addEventListener('abort', () => resolve(undefined))
  })
}
