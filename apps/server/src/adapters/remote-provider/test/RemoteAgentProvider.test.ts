import { afterEach, describe, expect, it } from 'bun:test'
import type { AdmissionRequest, ProviderInput } from '@ia-flow/ai-providers'
import { ProviderAtCapacityError } from '@ia-flow/ai-providers'
import type { ProviderRegistration } from '../../../domain/ports/IProviderRegistrationRepository.js'
import { RemoteAgentProvider, remoteProviderId } from '../RemoteAgentProvider.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return {
    id: 'reg-1',
    name: 'mi gateway',
    baseUrl: 'https://gateway.example.com',
    token: 'secret-token',
    remoteKind: 'sync',
    remoteName: 'Claude Print',
    remoteDescription: 'invoca claude -p',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function baseInput(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    step: 'implement',
    taskId: 't1',
    taskTitle: 'x',
    taskDescription: '',
    taskType: 'functional',
    repos: [],
    repoPaths: {},
    prompt: 'hola',
    ...overrides,
  }
}

describe('remoteProviderId', () => {
  it('namespacea con el prefijo remote:', () => {
    expect(remoteProviderId('abc')).toBe('remote:abc')
  })
})

describe('RemoteAgentProvider', () => {
  it('id/kind/name/description se derivan de la registración', () => {
    const provider = new RemoteAgentProvider(registration())
    expect(provider.id).toBe('remote:reg-1')
    expect(provider.kind).toBe('sync')
    expect(provider.name).toBe('Claude Print (mi gateway)')
    expect(provider.description).toBe('invoca claude -p')
  })

  it('run() hace POST a <baseUrl>/v1/run con bearer token', async () => {
    let capturedUrl: string | undefined
    let capturedHeaders: Record<string, string> | undefined
    let capturedBody: unknown
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url
      capturedHeaders = init.headers as Record<string, string>
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ content: 'listo', mode: 'api' }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    const output = await provider.run(baseInput({ prompt: 'hacé esto' }))

    expect(capturedUrl).toBe('https://gateway.example.com/v1/run')
    expect(capturedHeaders?.authorization).toBe('Bearer secret-token')
    expect((capturedBody as { prompt: string }).prompt).toBe('hacé esto')
    expect(output).toEqual({ content: 'listo', mode: 'api' })
  })

  it('serializa policy.toolNames como array — un Set se pierde en JSON.stringify', async () => {
    // Regression: input.policy.toolNames es un Set (PolicyLike). Sin
    // convertirlo antes de JSON.stringify, el gateway remoto recibe `{}` en
    // vez del allow-list real y explota con "Spread syntax requires
    // ...iterable[Symbol.iterator] to be a function" al intentar
    // reconstruirlo (ver packages/ai-providers/src/anthropic-api/provider.ts).
    let capturedBody: { policy?: { toolNames?: unknown } } | undefined
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ content: 'listo', mode: 'api' }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    await provider.run(
      baseInput({ policy: { toolNames: new Set(['read_file', 'update_issue_body']) } }),
    )

    expect(Array.isArray(capturedBody?.policy?.toolNames)).toBe(true)
    expect(capturedBody?.policy?.toolNames).toEqual(['read_file', 'update_issue_body'])
  })

  it('respuesta no-2xx → lanza con el body y el id del provider', async () => {
    globalThis.fetch = (async () =>
      new Response('gateway caído', { status: 502 })) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    await expect(provider.run(baseInput())).rejects.toThrow(/remote:reg-1.*502.*gateway caído/s)
  })
})

describe('RemoteAgentProvider.canAccept', () => {
  function admissionReq(overrides: Partial<AdmissionRequest> = {}): AdmissionRequest {
    return {
      task: { id: 't1', title: 'x', status: 'Build' } as AdmissionRequest['task'],
      running: 0,
      ...overrides,
    }
  }

  it('pega a /v1/capacity con el token y propaga el motivo del gateway', async () => {
    const seen: { url?: string; auth?: string } = {}
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.url = url
      seen.auth = (init?.headers as Record<string, string>)?.authorization
      return new Response(JSON.stringify({ accepting: false, reason: 'RAM al límite' }), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const verdict = await new RemoteAgentProvider(registration()).canAccept(admissionReq())

    expect(verdict.accept).toBe(false)
    // El motivo del otro proceso llega intacto al log de este daemon.
    expect(verdict).toMatchObject({ reason: 'gateway: RAM al límite' })
    expect(seen.url).toBe('https://gateway.example.com/v1/capacity')
    expect(seen.auth).toBe('Bearer secret-token')
  })

  it('propaga retryAfterMs cuando el gateway lo manda', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepting: false, reason: 'ocupado', retryAfterMs: 30_000 }), {
        status: 200,
      })) as unknown as typeof fetch

    const verdict = await new RemoteAgentProvider(registration()).canAccept(admissionReq())
    expect(verdict).toMatchObject({ accept: false, retryAfterMs: 30_000 })
  })

  it('accepting=true → toma trabajo', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ accepting: true }), { status: 200 })) as unknown as typeof fetch
    const verdict = await new RemoteAgentProvider(registration()).canAccept(admissionReq())
    expect(verdict.accept).toBe(true)
  })

  it('el cap declarado se resuelve local, sin gastar la sonda de red', async () => {
    let probed = false
    globalThis.fetch = (async () => {
      probed = true
      return new Response(JSON.stringify({ accepting: true }), { status: 200 })
    }) as unknown as typeof fetch

    const verdict = await new RemoteAgentProvider(registration()).canAccept(
      admissionReq({ running: 2, cap: 2 }),
    )
    expect(verdict).toMatchObject({ accept: false })
    expect(probed).toBe(false)
  })

  it('fail-open: un gateway viejo sin el endpoint (404) no bloquea el dispatch', async () => {
    globalThis.fetch = (async () =>
      new Response('not found', { status: 404 })) as unknown as typeof fetch
    expect((await new RemoteAgentProvider(registration()).canAccept(admissionReq())).accept).toBe(
      true,
    )
  })

  it('fail-open: un error de red tampoco bloquea — que falle el run, no la sonda', async () => {
    globalThis.fetch = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect((await new RemoteAgentProvider(registration()).canAccept(admissionReq())).accept).toBe(
      true,
    )
  })

  it('fail-open: una respuesta sin `accepting` se lee como disponible', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ running: 1 }), { status: 200 })) as unknown as typeof fetch
    expect((await new RemoteAgentProvider(registration()).canAccept(admissionReq())).accept).toBe(
      true,
    )
  })
})

describe('RemoteAgentProvider.run — 503 del gateway', () => {
  it('lanza ProviderAtCapacityError, no un error de run', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'runs en curso al tope (2/2)' }), {
        status: 503,
      })) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    // Se distingue del error genérico porque aguas arriba decide entre
    // "difiero y reintento" y "corré el onError del agente".
    expect(provider.run(baseInput())).rejects.toBeInstanceOf(ProviderAtCapacityError)
  })

  it('lee Retry-After (segundos) y lo expone en ms', async () => {
    globalThis.fetch = (async () =>
      new Response('busy', {
        status: 503,
        headers: { 'retry-after': '45' },
      })) as unknown as typeof fetch

    const err = await new RemoteAgentProvider(registration())
      .run(baseInput())
      .catch((e: unknown) => e)
    expect((err as ProviderAtCapacityError).retryAfterMs).toBe(45_000)
  })

  it('sin Retry-After queda undefined, no 0 (0 sería "reintentá ya")', async () => {
    globalThis.fetch = (async () =>
      new Response('busy', { status: 503 })) as unknown as typeof fetch

    const err = await new RemoteAgentProvider(registration())
      .run(baseInput())
      .catch((e: unknown) => e)
    expect((err as ProviderAtCapacityError).retryAfterMs).toBeUndefined()
  })

  it('cualquier otro status sigue siendo un error de run común', async () => {
    globalThis.fetch = (async () =>
      new Response('boom', { status: 500 })) as unknown as typeof fetch

    const err = await new RemoteAgentProvider(registration())
      .run(baseInput())
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ProviderAtCapacityError)
  })
})

describe('RemoteAgentProvider — runs async', () => {
  it('manda cómo alcanzar a este daemon: allá `localhost` es el gateway', async () => {
    let sent: { daemonUrl?: string } = {}
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string)
      return new Response(JSON.stringify({ content: '', mode: 'api' }), { status: 200 })
    }) as unknown as typeof fetch

    await new RemoteAgentProvider(registration()).run(baseInput())

    // El valor exacto depende del entorno; lo que importa es que viaje, para
    // que el provider de terminal no caiga a su default de localhost.
    expect(sent.daemonUrl).toBeTruthy()
  })

  it('rehidrata la sesión: sus funciones se perdieron al serializar', async () => {
    const calls: string[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`)
      if (String(url).endsWith('/v1/run')) {
        return new Response(
          JSON.stringify({ content: '', mode: 'tmux', session: { kind: 'tmux', id: 's1' } }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ alive: true, known: true }), { status: 200 })
    }) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(typeof out.session?.isAlive).toBe('function')
    expect(await out.session?.isAlive()).toBe(true)
    await out.session?.close()
    expect(calls).toEqual([
      'POST https://gateway.example.com/v1/run',
      'GET https://gateway.example.com/v1/sessions/s1',
      'DELETE https://gateway.example.com/v1/sessions/s1',
    ])
  })

  it('si no podemos preguntar, la damos por VIVA — cerrar de más pierde el run', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/v1/run')) {
        return new Response(
          JSON.stringify({ content: '', mode: 'tmux', session: { kind: 'tmux', id: 's1' } }),
          { status: 200 },
        )
      }
      throw new Error('gateway caído')
    }) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(await out.session?.isAlive()).toBe(true)
  })

  it('un run sync no inventa sesión', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ content: 'ok', mode: 'api' }), {
        status: 200,
      })) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(out.session).toBeUndefined()
  })
})
