import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProviderInput, ProviderOutput } from '@ia-flow/ai-providers'
import type { ProviderRegistration } from '../../../domain/ports/IProviderRegistrationRepository.js'
import { RemoteAgentProvider } from '../RemoteAgentProvider.js'

const originalFetch = globalThis.fetch
const originalInterval = Bun.env.IA_FLOW_REMOTE_POLL_INTERVAL_MS

// El interval se lee por vuelta (lazy), así que alcanza con fijarlo acá.
// Sin esto cada sonda esperaría los 2s del default.
beforeEach(() => {
  Bun.env.IA_FLOW_REMOTE_POLL_INTERVAL_MS = '50'
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalInterval === undefined) delete Bun.env.IA_FLOW_REMOTE_POLL_INTERVAL_MS
  else Bun.env.IA_FLOW_REMOTE_POLL_INTERVAL_MS = originalInterval
})

function registration(): ProviderRegistration {
  return {
    id: 'reg-1',
    name: 'mi agent-host',
    baseUrl: 'https://agent-host.example.com',
    token: 'secret-token',
    remoteKind: 'sync',
    remoteName: 'x',
    remoteDescription: 'y',
    createdAt: '2026-01-01T00:00:00Z',
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

const DONE: ProviderOutput = { content: 'listo', mode: 'api', stopReason: 'end_turn' }

/**
 * Un agent-host que acepta con 202 y después contesta lo que le digamos en
 * cada sonda. `polls` se consume en orden; la última se repite.
 */
function fakeHost(polls: unknown[], opts: { onDelete?: () => void } = {}) {
  let i = 0
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    calls.push(`${init?.method ?? 'GET'} ${u}`)
    if (u.includes('/v1/run?')) {
      return new Response(JSON.stringify({ accepted: true, runId: 'r1' }), { status: 202 })
    }
    if (init?.method === 'DELETE') {
      opts.onDelete?.()
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 })
    }
    const body = polls[Math.min(i++, polls.length - 1)]
    if (body instanceof Error) throw body
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  return { calls }
}

describe('run desacoplado — el request ya no dura lo que dura el run', () => {
  it('acepta con 202 y devuelve el output que trae el sondeo', async () => {
    fakeHost([{ status: 'running' }, { status: 'done', output: DONE }])

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(out.content).toBe('listo')
    expect(out.stopReason).toBe('end_turn')
  })

  it('un agent-host viejo que contesta 200 sigue funcionando', async () => {
    // Ignora el `?wait=poll` y cuelga el output del request, como siempre. Un
    // daemon nuevo tiene que poder hablarle igual.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(DONE), { status: 200 })) as unknown as typeof fetch

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(out.content).toBe('listo')
  })

  it('un fallo del run vuelve como error, no como output vacío', async () => {
    fakeHost([{ status: 'failed', error: 'el provider explotó' }])

    const run = new RemoteAgentProvider(registration()).run(baseInput())

    await expect(run).rejects.toThrow('el provider explotó')
  })

  it('una sonda que falla NO mata el run — se reintenta', async () => {
    // Es lo que el request colgado no podía hacer: cualquier corte de red se
    // leía como un run fallido, con su onError comentando un fallo sobre
    // trabajo que seguía avanzando.
    fakeHost([new Error('ECONNRESET'), { status: 'running' }, { status: 'done', output: DONE }])

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(out.content).toBe('listo')
  })

  it('un run que el agent-host ya no conoce se reporta, no se espera para siempre', async () => {
    // Reinició, y el run murió con él.
    fakeHost([{ status: 'unknown' }])

    const run = new RemoteAgentProvider(registration()).run(baseInput())

    await expect(run).rejects.toThrow('perdió el run')
  })
})

describe('run desacoplado — diagnósticos que no se confunden', () => {
  it('`done` sin output dice eso, y no "perdió el run"', async () => {
    // Son diagnósticos opuestos: uno apunta al agent-host que reinició, el
    // otro a un provider que resolvió vacío. Mandarlos al mismo mensaje
    // manda al operador a buscar en el lugar equivocado.
    fakeHost([{ status: 'done' }])

    const run = new RemoteAgentProvider(registration()).run(baseInput())

    await expect(run).rejects.toThrow('terminó sin output')
  })

  it('`IA_FLOW_REMOTE_MAX_SILENCE_MS=0` es sin límite, no "cortá al primer fallo"', async () => {
    // La convención del repo: 0 = sin tope. Con `>= 0` a secas, un operador
    // que lo ponía en 0 para desactivar el corte obtenía el comportamiento
    // más agresivo posible.
    Bun.env.IA_FLOW_REMOTE_MAX_SILENCE_MS = '0'
    fakeHost([new Error('ECONNRESET'), { status: 'done', output: DONE }])

    const out = await new RemoteAgentProvider(registration()).run(baseInput())

    expect(out.content).toBe('listo')
    delete Bun.env.IA_FLOW_REMOTE_MAX_SILENCE_MS
  })
})

describe('run desacoplado — el cancel', () => {
  it('le avisa al agent-host: si no, el CLI sigue trabajando', async () => {
    let deleted = false
    fakeHost([{ status: 'running' }], { onDelete: () => (deleted = true) })
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 300)

    const run = new RemoteAgentProvider(registration()).run(baseInput({ signal: ctrl.signal }))

    await expect(run).rejects.toThrow('cancelado')
    expect(deleted).toBe(true)
  })
})
