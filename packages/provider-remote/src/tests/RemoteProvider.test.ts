import { describe, expect, it } from 'vitest'
import {
  call,
  delay,
  makeClient,
  makeHost,
  runContext,
  ScriptedProvider,
  tool,
  wire,
} from './fixtures.js'

describe('RemoteProvider.run', () => {
  it('corre en el host con las tools del runner y devuelve su output', async () => {
    const local = new ScriptedProvider('local', async (ctx) => {
      const read = await call(ctx, 'read_issue', { number: 7 })
      await call(ctx, 'submit_done', { summary: read })
      return { outcome: 'success', summary: 'listo' }
    })
    const host = makeHost([local])
    const seen: unknown[] = []
    const ctx = runContext({
      tools: [
        tool('read_issue', (input) => {
          seen.push(input)
          return 'el issue 7'
        }),
        tool(
          'submit_done',
          (input) => {
            seen.push(input)
            return 'ok'
          },
          { terminal: true },
        ),
      ],
    })

    const output = await makeClient(host).run(ctx)

    expect(output).toEqual({ outcome: 'success', summary: 'listo' })
    expect(seen).toEqual([{ number: 7 }, { summary: 'el issue 7' }])
    // Lo que el provider de allá ve: el prompt, el evento y las tools sin sus handlers de acá.
    const remote = local.runs[0]
    expect(remote?.prompt).toBe('hacé la tarea')
    expect(remote?.ctx.event.payload).toEqual({ owner: 'la-haus', repo: 'eks', number: 7 })
    expect(remote?.tools.find((t) => t.name === 'submit_done')?.terminal).toBe(true)
    // Terminó: el runner la soltó y el host ya no la lleva.
    expect(host.running('local')).toBe(0)
  })

  it('un error de la tool le llega al provider del host como excepción', async () => {
    const local = new ScriptedProvider('local', async (ctx) => {
      const error = await Promise.resolve(call(ctx, 'boom')).catch((e: Error) => e.message)
      return { outcome: 'error', summary: String(error) }
    })
    const ctx = runContext({
      tools: [
        tool('boom', () => {
          throw new Error('se rompió acá')
        }),
      ],
    })

    const output = await makeClient(makeHost([local])).run(ctx)

    expect(output.summary).toBe('se rompió acá')
  })

  it('guarda la conversación que va guardando el provider del host y le pasa el resume', async () => {
    const local = new ScriptedProvider('local', async (ctx) => {
      ctx.saveConversation?.({ sessionId: 'a' })
      ctx.saveConversation?.({ sessionId: 'b' })
      return { outcome: 'success', conversation: { sessionId: 'b' } }
    })
    const saved: unknown[] = []
    const ctx = runContext({
      saveConversation: (conversation) => saved.push(conversation),
      resume: { conversation: { sessionId: 'x' }, message: 'llegó un comentario' },
    })

    const output = await makeClient(makeHost([local])).run(ctx)

    expect(output.conversation).toEqual({ sessionId: 'b' })
    // La que el runner no levantó a tiempo se reemplaza: sólo importa la última.
    expect(saved.at(-1)).toEqual({ sessionId: 'b' })
    expect(local.runs[0]?.resume).toEqual({
      conversation: { sessionId: 'x' },
      message: 'llegó un comentario',
    })
  })

  it('le entrega al host lo que llega al inbox mientras corre', async () => {
    const pending = ['revisá el test']
    const local = new ScriptedProvider('local', async (ctx) => {
      let got: string[] = []
      for (let i = 0; i < 50 && got.length === 0; i++) {
        await delay(10)
        got = ctx.inbox?.() ?? []
      }
      return { outcome: 'success', summary: got.join('|') }
    })
    const ctx = runContext({ inbox: () => pending.splice(0) })

    const output = await makeClient(makeHost([local])).run(ctx)

    expect(output.summary).toBe('revisá el test')
  })

  it('sin inbox en el runner, el provider del host no lo tiene', async () => {
    const local = new ScriptedProvider('local', async () => ({ outcome: 'success' }))
    await makeClient(makeHost([local])).run(runContext())
    expect(local.runs[0]?.inbox).toBeUndefined()
    expect(local.runs[0]?.saveConversation).toBeUndefined()
  })

  it('una corrida que falla en el host tira con el motivo', async () => {
    const local = new ScriptedProvider('local', async () => {
      throw new Error('la API dijo 529')
    })
    await expect(makeClient(makeHost([local])).run(runContext())).rejects.toThrow(
      'remote: la API dijo 529',
    )
  })

  it('al tope al abrir (la sonda es consultiva): espera y reintenta', async () => {
    let release!: () => void
    const blocker = new Promise<void>((resolve) => {
      release = resolve
    })
    const local = new ScriptedProvider(
      'local',
      async (ctx) => {
        if (ctx.agentId === 'first') await blocker
        return { outcome: 'success', summary: ctx.agentId }
      },
      1,
    )
    const host = makeHost([local], { busyRetryMs: 20 })
    const client = makeClient(host)
    const first = client.run(runContext({ agentId: 'first' }))
    await delay(20)
    const second = client.run(runContext({ agentId: 'second' }))
    await delay(60)
    expect(local.runs).toHaveLength(1)

    release()

    expect((await first).summary).toBe('first')
    expect((await second).summary).toBe('second')
  })

  it('da la corrida por perdida si el host no contesta más que maxSilence', async () => {
    const local = new ScriptedProvider('local', () => new Promise(() => {}))
    const host = makeHost([local])
    const direct = wire(host)
    let down = false
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      if (down) throw new TypeError('fetch failed')
      return direct(input, init)
    }) as typeof fetch
    const client = makeClient(flaky, { maxSilenceSeconds: 0.05 })
    const running = client.run(runContext())
    await delay(20)
    down = true

    await expect(running).rejects.toThrow(/el host dejó de responder/)
  })

  it('un 404 en el sync tira "perdió la corrida"', async () => {
    const local = new ScriptedProvider('local', () => new Promise(() => {}))
    const host = makeHost([local])
    const direct = wire(host)
    const lossy = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.endsWith('/sync')) return new Response('{}', { status: 404 })
      return direct(input, init)
    }) as typeof fetch

    await expect(makeClient(lossy).run(runContext())).rejects.toThrow(/perdió la corrida/)
  })
})

describe('RemoteProvider.canAccept', () => {
  const request = () => ({ agentId: 'implementer', ctx: runContext().ctx })

  it('admite si el host tiene lugar', async () => {
    const local = new ScriptedProvider('local', async () => ({ outcome: 'success' }), 2)
    expect(await makeClient(makeHost([local])).canAccept(request())).toEqual({ accept: true })
  })

  it('demora si el host está al tope, con su motivo y cuándo volver', async () => {
    const local = new ScriptedProvider('local', () => new Promise(() => {}), 1)
    const host = makeHost([local], { busyRetryMs: 1234 })
    const client = makeClient(host)
    void client.run(runContext())
    await delay(20)

    const admission = await client.canAccept(request())

    expect(admission).toEqual({
      accept: false,
      reason: 'host http://host.test: local al tope (1/1)',
      retryAfterMs: 1234,
    })
    host.close()
  })

  it('las reglas del host ven las pistas: agente, tipo de evento, scope y las del runner', async () => {
    const local = new ScriptedProvider('local', async () => ({ outcome: 'success' }))
    const seen: Record<string, string[]>[] = []
    const host = makeHost([local], {
      admit: ({ hints }) => {
        seen.push(hints)
        return hints.repo?.includes('la-haus/eks')
          ? { accept: false, reason: 'eks no corre acá' }
          : { accept: true }
      },
    })
    const client = makeClient(host, {
      hints: (ctx) => {
        const { owner, repo } = ctx.event.payload as { owner: string; repo: string }
        return { repo: [`${owner}/${repo}`] }
      },
    })

    const admission = await client.canAccept(request())

    expect(admission).toMatchObject({
      accept: false,
      reason: 'host http://host.test: eks no corre acá',
    })
    expect(seen[0]).toEqual({
      agentId: ['implementer'],
      eventType: ['github.issues'],
      projectId: ['p1'],
      repo: ['la-haus/eks'],
    })
  })

  it('un host inalcanzable demora la corrida (no la manda a fallar)', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    const admission = await makeClient(down).canAccept(request())
    expect(admission).toMatchObject({ accept: false, retryAfterMs: 10 })
    expect(admission.accept === false && admission.reason).toMatch(/inalcanzable/)
  })

  it('una respuesta que no es un "no" explícito admite (fail-open)', async () => {
    const old = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch
    expect(await makeClient(old).canAccept(request())).toEqual({ accept: true })
  })
})
