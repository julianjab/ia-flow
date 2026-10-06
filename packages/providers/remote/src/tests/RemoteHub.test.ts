import type { Provider, Tool } from '@ia-flow/agent-engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostClient } from '../HostClient.js'
import type { HostTask } from '../protocol.js'
import {
  callTool,
  link,
  makeHost,
  makeHub,
  output,
  post,
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

const submit = () => tool('submit_done', () => 'elegiste done', { terminal: true })

describe('suscripción', () => {
  it('un host suscrito aparece como remote:<name>; sin el token del runner, no', async () => {
    const { hub, registry } = makeHub()
    const res = await wire(hub)(`${RUNNER}/v1/hosts/subscribe`, {
      method: 'POST',
      headers: { authorization: 'Bearer otro' },
      body: JSON.stringify({ name: 'laptop' }),
    })
    expect(res.status).toBe(401)

    started(makeHost(hub, async () => output()))
    await until(() => registry.resolve('remote:laptop') !== undefined)
    expect(hub.list()).toMatchObject([{ name: 'laptop', provider: 'remote:laptop', running: 0 }])
  })

  it('los remote:<name> van y vienen: antes de que su host se suscriba, un agente los espera', () => {
    const { registry } = makeHub()
    expect(registry.isDynamic('remote:e2e')).toBe(true)
    expect(registry.isDynamic('claude-cli')).toBe(false)
  })

  it('sin token ningún host se puede suscribir: un remote:<name> no se espera, falla como siempre', () => {
    const { registry } = makeHub({ token: undefined })
    expect(registry.isDynamic('remote:e2e')).toBe(false)
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
    const host = started(
      makeHost(hub, async (_task, _runner, signal) => {
        await aborted(signal)
        return output()
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    const running = provider.run(runContext({ tools: [submit()] }))
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
      new HostClient({
        runnerUrl: RUNNER,
        token: TOKEN,
        name: 'laptop',
        maxConcurrent: 1,
        accepts: [],
        run: async () => output(),
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
  it('el host la corre con su provider: las tools del engine corren acá, y su resultado vuelve tal cual', async () => {
    const { hub, registry } = makeHub()
    const seen: HostTask[] = []
    const ran = vi.fn(() => 'elegiste done')
    started(
      makeHost(hub, async (task) => {
        seen.push(task)
        // El provider del host: una tool del engine (corre en el runner) y su resultado.
        const reply = await callTool(hub, task, 'submit_done', { summary: 'listo' })
        return output('success', { summary: reply.text, conversation: { messages: 3 } })
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    // Recibe todas las tools: las de workspace no corren acá, pero viajan con su origen.
    expect(provider.workspace).toBe('runner')

    const bash: Tool = {
      ...tool('bash_run', () => 'no corre acá'),
      workspace: true,
      origin: { action: 'bash_run', options: { deny: ['rm -rf'] } },
    }
    const orphan: Tool = { ...tool('fs_mystery', () => 'x'), workspace: true }
    const result = await provider.run(
      runContext({
        systemPrompts: ['sos el implementer'],
        variables: { repo: 'eks' },
        providerConfig: { model: 'opus' },
        mcpServers: [
          { id: 'linear', config: { url: 'https://mcp', authorizationToken: () => 't0k' } },
        ],
        tools: [
          tool('submit_done', ran, { terminal: true }),
          tool('fail_turn', () => 'x', { terminal: true, failure: true }),
          bash,
          orphan,
        ],
      }),
    )

    expect(result).toEqual({
      outcome: 'success',
      summary: 'elegiste done',
      conversation: { messages: 3 },
    })
    expect(ran).toHaveBeenCalledWith({ summary: 'listo' })
    expect(seen[0]).toMatchObject({
      agentId: 'implementer',
      prompt: 'hacé la tarea',
      systemPrompts: ['sos el implementer'],
      variables: { repo: 'eks' },
      providerConfig: { model: 'opus' },
      mcpServers: [{ id: 'linear', config: { url: 'https://mcp', authorizationToken: 't0k' } }],
      event: { type: 'issue.status_changed', payload: { repo: 'eks', number: 7 } },
      tools: [
        { name: 'submit_done', terminal: true },
        { name: 'fail_turn', terminal: true, failure: true },
      ],
      workspaceTools: [
        { name: 'bash_run', origin: { action: 'bash_run', options: { deny: ['rm -rf'] } } },
      ],
    })
    // La de workspace sin origen no se puede rearmar: no viaja.
    expect(JSON.stringify(seen[0])).not.toContain('fs_mystery')
  })

  it('el carril de un miembro de un grupo `parallel` viaja al host (su propio worktree allá)', async () => {
    const { hub, registry } = makeHub()
    const seen: HostTask[] = []
    started(
      makeHost(hub, async (task) => {
        seen.push(task)
        return output()
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    const base = runContext()
    await provider.run(runContext({ ctx: { ...base.ctx, lane: 'e2e-visual-qa' } }))
    expect(seen[0]?.lane).toBe('e2e-visual-qa')
    // Sin carril (un paso suelto), el campo no viaja.
    await provider.run(runContext())
    expect(seen[1]).not.toHaveProperty('lane')
  })

  it('una conversación a retomar viaja tal cual: la entiende el provider del host', async () => {
    const { hub, registry } = makeHub()
    const seen: HostTask[] = []
    started(
      makeHost(hub, async (task) => {
        seen.push(task)
        return output()
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    await (registry.resolve('remote:laptop') as Provider).run(
      runContext({ resume: { conversation: { sessionId: 'sesion-1' }, message: 'el CI pasó' } }),
    )
    expect(seen[0]?.resume).toEqual({
      conversation: { sessionId: 'sesion-1' },
      message: 'el CI pasó',
    })
  })

  it('la bandeja, la conversación y el texto del host llegan al contexto del runner', async () => {
    const { hub, registry } = makeHub()
    const inbox = ['el humano comentó']
    const saved: unknown[] = []
    const texts: string[] = []
    started(
      makeHost(hub, async (task) => {
        const runner = link(hub, task)
        runner.start()
        await until(() => runner.inbox().length > 0 || inbox.length === 0)
        runner.saveConversation({ step: 1 })
        runner.saveConversation({ step: 2 })
        runner.onText('hola ')
        runner.onText('mundo')
        await runner.stop()
        return output()
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    await (registry.resolve('remote:laptop') as Provider).run(
      runContext({
        inbox: () => inbox.splice(0),
        saveConversation: (conversation) => saved.push(conversation),
        onText: (delta) => texts.push(delta),
      }),
    )
    expect(inbox).toEqual([])
    expect(saved).toEqual([{ step: 1 }, { step: 2 }])
    expect(texts.join('')).toBe('hola mundo')
  })

  it('las tools del engine por RunnerLink: un error vuelve al modelo, y una terminal marca cómo cerró', async () => {
    const { hub, registry } = makeHub()
    const endings: unknown[] = []
    const errors: string[] = []
    started(
      makeHost(hub, async (task) => {
        const runner = link(hub, task)
        const [boom, done] = runner.tools()
        await Promise.resolve()
          .then(() => boom?.handler({}))
          .catch((error: Error) => errors.push(error.message))
        endings.push(runner.ending)
        await done?.handler({})
        endings.push(runner.ending)
        return output()
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    await (registry.resolve('remote:laptop') as Provider).run(
      runContext({
        tools: [
          tool('comment', () => {
            throw new Error('GitHub dijo 422')
          }),
          tool('fail_turn', () => 'ok', { terminal: true, failure: true }),
        ],
      }),
    )
    expect(errors).toEqual(['GitHub dijo 422'])
    expect(endings).toEqual([undefined, 'failed'])
  })

  it('si el host no pudo correrla, la corrida es un error que dice por qué', async () => {
    const { hub, registry } = makeHub()
    started(makeHost(hub, async () => ({ status: 'failed', message: 'el worktree no se armó' })))
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const result = await (registry.resolve('remote:laptop') as Provider).run(runContext())
    expect(result).toMatchObject({
      outcome: 'error',
      summary: 'remote:laptop no pudo correrla: el worktree no se armó',
    })
  })

  it('una corrida desconocida es un 404; un body que no es del protocolo, un 400', async () => {
    const { hub, registry } = makeHub()
    expect(
      (await post(hub, `${RUNNER}/v1/runs/nadie/tools`, { name: 'x', input: {} })).status,
    ).toBe(404)
    const statuses: number[] = []
    started(
      makeHost(hub, async (task) => {
        statuses.push((await post(hub, `${RUNNER}${task.endpoints.text}`, { deltas: 1 })).status)
        statuses.push(
          (await post(hub, `${RUNNER}${task.endpoints.tools}`, { name: 'nadie' })).status,
        )
        return output()
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    await (registry.resolve('remote:laptop') as Provider).run(runContext())
    expect(statuses).toEqual([400, 200])
  })
})

describe('canAccept', () => {
  it('con las condiciones del host (el when de las pipelines) y su tope, sin ir al host', async () => {
    const { hub, registry } = makeHub()
    started(
      makeHost(hub, async () => output(), {
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
      makeHost(hub, async () => {
        await gate
        return output()
      }),
    )
    await until(() => registry.resolve('remote:laptop') !== undefined)
    const provider = registry.resolve('remote:laptop') as Provider
    const first = provider.run(runContext())
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

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    signal.addEventListener('abort', () => resolve())
  })
}
