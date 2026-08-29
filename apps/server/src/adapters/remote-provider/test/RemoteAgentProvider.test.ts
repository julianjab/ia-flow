import { afterEach, describe, expect, it } from 'bun:test'
import type { AdmissionRequest, ProviderInput } from '@ia-flow/ai-providers'
import { ProviderAtCapacityError } from '@ia-flow/ai-providers'
import { EMPTY_WORKSPACE_PLAN } from '@ia-flow/shared'
import type { ProviderRegistration } from '../../../domain/ports/IProviderRegistrationRepository.js'
import { RemoteAgentProvider, readLiveness, remoteProviderId } from '../RemoteAgentProvider.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function registration(overrides: Partial<ProviderRegistration> = {}): ProviderRegistration {
  return {
    id: 'reg-1',
    name: 'mi agent-host',
    baseUrl: 'https://agent-host.example.com',
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
    expect(provider.name).toBe('Claude Print (mi agent-host)')
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

    expect(capturedUrl).toBe('https://agent-host.example.com/v1/run')
    expect(capturedHeaders?.authorization).toBe('Bearer secret-token')
    expect((capturedBody as { prompt: string }).prompt).toBe('hacé esto')
    expect(output).toEqual({ content: 'listo', mode: 'api' })
  })

  it('serializa policy.toolNames como array — un Set se pierde en JSON.stringify', async () => {
    // Regression: input.policy.toolNames es un Set (PolicyLike). Sin
    // convertirlo antes de JSON.stringify, el agent-host remoto recibe `{}` en
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
      new Response('agent-host caído', { status: 502 })) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    await expect(provider.run(baseInput())).rejects.toThrow(/remote:reg-1.*502.*agent-host caído/s)
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

  it('pega a /v1/capacity con el token y propaga el motivo del agent-host', async () => {
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
    expect(verdict).toMatchObject({ reason: 'agent-host: RAM al límite' })
    expect(seen.url).toBe('https://agent-host.example.com/v1/capacity')
    expect(seen.auth).toBe('Bearer secret-token')
  })

  it('manda las pistas de la tarea en la query — la regla del agent-host corta en la sonda', async () => {
    // Un rechazo en la sonda hace que resolveProvider pruebe el siguiente
    // candidato; el mismo rechazo recién en POST /v1/run (503) difiere el
    // issue — para una regla estática (assignee, repo) sería diferir para
    // siempre. Por eso las pistas tienen que viajar acá.
    const seen: { url?: string } = {}
    globalThis.fetch = (async (url: string) => {
      seen.url = url
      return new Response(JSON.stringify({ accepting: true }), { status: 200 })
    }) as unknown as typeof fetch

    await new RemoteAgentProvider(registration()).canAccept(
      admissionReq({
        agentId: 'subscriptions-implementer',
        task: {
          id: 't1',
          title: 'x',
          status: 'Build',
          projectId: 'subscriptions',
          type: 'feature',
          repos: ['subscriptions'],
          assignees: ['julianjab', 'otro'],
        } as AdmissionRequest['task'],
      }),
    )

    const params = new URL(seen.url ?? '').searchParams
    expect(params.getAll('repo')).toEqual(['subscriptions'])
    expect(params.getAll('assignee')).toEqual(['julianjab', 'otro'])
    expect(params.get('agentId')).toBe('subscriptions-implementer')
    expect(params.get('projectId')).toBe('subscriptions')
    expect(params.get('taskType')).toBe('feature')
  })

  it('assignees conocido-vacío viaja como marcador, distinto de no saber', async () => {
    // `assignees: []` (issue sin asignar) → `assignee=` vacío en la query,
    // para que la regla del agent-host lo rechace. Sin el campo, nada viaja y
    // la regla se saltea (fail-open del daemon viejo).
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(url)
      return new Response(JSON.stringify({ accepting: true }), { status: 200 })
    }) as unknown as typeof fetch

    const provider = new RemoteAgentProvider(registration())
    await provider.canAccept(
      admissionReq({
        task: { id: 't1', title: 'x', status: 'Build', assignees: [] } as AdmissionRequest['task'],
      }),
    )
    await provider.canAccept(admissionReq())

    expect(new URL(urls[0] ?? '').searchParams.getAll('assignee')).toEqual([''])
    expect(new URL(urls[1] ?? '').searchParams.has('assignee')).toBe(false)
  })

  it('propaga retryAfterMs cuando el agent-host lo manda', async () => {
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

  it('fail-open: un agent-host viejo sin el endpoint (404) no bloquea el dispatch', async () => {
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

describe('RemoteAgentProvider.run — 503 del agent-host', () => {
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
  it('manda cómo alcanzar a este daemon: allá `localhost` es el agent-host', async () => {
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

    expect(typeof out.session?.liveness).toBe('function')
    expect(await out.session?.liveness()).toBe('alive')
    await out.session?.close()
    // El `?kind=` viaja en las dos: es lo que le permite al agent-host
    // reconstruir la sesión desde el SO si reinició y la perdió del mapa.
    expect(calls).toEqual([
      'POST https://agent-host.example.com/v1/run',
      'GET https://agent-host.example.com/v1/sessions/s1?kind=tmux',
      'DELETE https://agent-host.example.com/v1/sessions/s1?kind=tmux',
    ])
  })

  it('si no podemos preguntar, es unknown — no muerta', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/v1/run')) {
        return new Response(
          JSON.stringify({ content: '', mode: 'tmux', session: { kind: 'tmux', id: 's1' } }),
          { status: 200 },
        )
      }
      throw new Error('agent-host caído')
    }) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(await out.session?.liveness()).toBe('unknown')
  })

  // El incidente exacto: el agent-host reinició con la sesión de tmux corriendo,
  // contestó "no la conozco", y el daemon lo leyó como muerta — abandonando
  // un run que seguía trabajando.
  it('"no conozco esa sesión" es unknown, no muerta', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/v1/run')) {
        return new Response(
          JSON.stringify({ content: '', mode: 'tmux', session: { kind: 'tmux', id: 's1' } }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ alive: false, known: false }), { status: 200 })
    }) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(await out.session?.liveness()).toBe('unknown')
  })

  it('muerta sólo cuando el agent-host dice que la conoce y no está', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/v1/run')) {
        return new Response(
          JSON.stringify({ content: '', mode: 'tmux', session: { kind: 'tmux', id: 's1' } }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ liveness: 'dead', alive: false, known: true }), {
        status: 200,
      })
    }) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(await out.session?.liveness()).toBe('dead')
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

describe('RemoteAgentProvider.run — timeout del fetch', () => {
  // Regresión: sin `timeout` explícito manda el default del runtime (300s en
  // Bun >= 1.2), y un run remoto largo moría con
  // `TimeoutError: The operation timed out.` que el agente reportaba como
  // fallo real (onError → issue a blocked). Quién decide cuánto esperar es
  // el engine, no la versión de Bun que le tocó al container.
  it('desarma el default del runtime y pone su propio límite por AbortSignal', async () => {
    // `timeout` numérico NO configura milisegundos en Bun (es booleano) — el
    // corte real tiene que ser un AbortSignal.timeout propio.
    let capturedInit: RequestInit | undefined
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch

    await new RemoteAgentProvider(registration()).run(baseInput())

    expect((capturedInit as { timeout?: unknown } | undefined)?.timeout).toBe(false)
    expect(capturedInit?.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('RemoteAgentProvider — liveness sobre HTTP', () => {
  it('cerrar una sesión contra un agent-host caído no explota', async () => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/v1/run')) {
        return new Response(
          JSON.stringify({ content: '', mode: 'tmux', session: { kind: 'tmux', id: 's1' } }),
          { status: 200 },
        )
      }
      if (init?.method === 'DELETE') throw new Error('agent-host caído')
      return new Response(JSON.stringify({ liveness: 'alive', known: true }), { status: 200 })
    }) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    // Cerrar es best-effort: el run ya terminó, un agent-host inalcanzable no
    // debe convertirse en un error del cierre.
    await out.session?.close()
  })

  it('prepareWorkspace no arma nada de este lado del cable', async () => {
    expect(await new RemoteAgentProvider(registration()).prepareWorkspace()).toEqual(
      EMPTY_WORKSPACE_PLAN,
    )
  })

  it('un agent-host que responde no-2xx es unknown', async () => {
    globalThis.fetch = (async (url: string) => {
      if (String(url).endsWith('/v1/run')) {
        return new Response(
          JSON.stringify({ content: '', mode: 'tmux', session: { kind: 'tmux', id: 's1' } }),
          { status: 200 },
        )
      }
      return new Response('nope', { status: 500 })
    }) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(await out.session?.liveness()).toBe('unknown')
  })
})

// Traducción de la respuesta del agent-host a los tres estados. Es el punto
// exacto donde se coló el incidente: `known: false` ("reinicié y no la
// tengo") se leía como muerta y el watchdog abandonaba un run que seguía
// trabajando.
describe('readLiveness', () => {
  it('respeta el `liveness` explícito del agent-host nuevo', () => {
    expect(readLiveness({ liveness: 'alive' })).toBe('alive')
    expect(readLiveness({ liveness: 'dead' })).toBe('dead')
    expect(readLiveness({ liveness: 'unknown' })).toBe('unknown')
  })

  it('un `liveness` basura no se cree: cae al par alive/known', () => {
    expect(readLiveness({ liveness: 'quizás', alive: false, known: true })).toBe('dead')
  })

  it('agent-host viejo: known:false es unknown, no dead', () => {
    expect(readLiveness({ alive: false, known: false })).toBe('unknown')
  })

  it('agent-host viejo: known:true + alive:false sí es dead', () => {
    expect(readLiveness({ alive: false, known: true })).toBe('dead')
  })

  it('sin campos, se asume viva — cerrar de más pierde el run', () => {
    expect(readLiveness({})).toBe('alive')
  })
})
