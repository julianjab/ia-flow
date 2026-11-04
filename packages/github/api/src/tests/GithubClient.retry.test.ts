import type { GithubAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GithubApiError } from '../GithubApiError.js'
import { GithubClient } from '../GithubClient.js'
import type { GateClock } from '../RequestGate.js'

/** Un reloj que avanza al dormir: las esperas quedan anotadas y no tardan. */
function fakeClock(): GateClock & { slept: number[] } {
  let now = 1_000_000
  const slept: number[] = []
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms)
      now += ms
    },
  }
}

const auth = (): GithubAuth => ({ getToken: async () => 't' })

const secondary = (headers: Record<string, string> = {}) =>
  new Response(
    JSON.stringify({
      message: 'You have exceeded a secondary rate limit. Please wait a few minutes.',
    }),
    { status: 403, headers },
  )

function clientWith(responses: Array<() => Response>, opts: { maxRetries?: number } = {}) {
  const clock = fakeClock()
  const fetchImpl = vi.fn(async () => {
    const next = responses.shift()
    if (!next) throw new Error('sin más respuestas')
    return next()
  })
  const client = new GithubClient({
    auth: auth(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    clock,
    random: () => 0,
    retry: { maxRetries: opts.maxRetries ?? 3 },
  })
  return { client, clock, fetchImpl }
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error('se esperaba un error')
    },
    (err: unknown) => err as GithubApiError,
  )

describe('GithubClient — límite secundario', () => {
  it('reintenta un 403 de límite secundario respetando retry-after', async () => {
    const { client, clock, fetchImpl } = clientWith([
      () => secondary({ 'retry-after': '30' }),
      () => new Response('{"ok":true}', { status: 200 }),
    ])

    await expect(client.requestJson('/x')).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(clock.slept).toEqual([30_000])
  })

  it('sin retry-after espera 60 s y duplica en cada intento', async () => {
    const { client, clock } = clientWith([
      () => secondary(),
      () => secondary(),
      () => new Response('{}', { status: 200 }),
    ])

    await client.requestJson('/x')
    expect(clock.slept).toEqual([60_000, 120_000])
  })

  it('una cuota agotada espera hasta x-ratelimit-reset', async () => {
    const { client, clock } = clientWith([
      () =>
        new Response('{}', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(1_000_000 / 1000 + 42),
          },
        }),
      () => new Response('{}', { status: 200 }),
    ])

    await client.requestJson('/x')
    expect(clock.slept).toEqual([42_000])
  })

  it('agotados los reintentos, tira un GithubApiError transient', async () => {
    const { client, fetchImpl } = clientWith(
      [() => secondary(), () => secondary(), () => secondary()],
      { maxRetries: 2 },
    )

    const error = await failure(client.requestJson('/x'))
    expect(error).toBeInstanceOf(GithubApiError)
    expect(error.transient).toBe(true)
    expect(error.status).toBe(403)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('un retry-after más largo que maxWaitMs no se espera: sale transient enseguida', async () => {
    const clock = fakeClock()
    const fetchImpl = vi.fn(async () => secondary({ 'retry-after': '3600' }))
    const client = new GithubClient({
      auth: auth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      random: () => 0,
      retry: { maxWaitMs: 60_000 },
    })

    const error = await failure(client.requestJson('/x'))
    expect(error.transient).toBe(true)
    expect(error.retryAfterMs).toBe(3_600_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(clock.slept).toEqual([])
  })

  it('un 403 de permisos no se reintenta y no es transient', async () => {
    const { client, fetchImpl } = clientWith([
      () => new Response('{"message":"Resource not accessible by integration"}', { status: 403 }),
    ])

    const error = await failure(client.requestJson('/x'))
    expect(error.transient).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('request() devuelve la respuesta final con el body intacto', async () => {
    const { client } = clientWith([() => secondary()], { maxRetries: 0 })

    const res = await client.request('/x')
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('secondary rate limit')
  })

  it('una mutation GraphQL rechazada por límite secundario se reintenta', async () => {
    const { client, fetchImpl } = clientWith([
      () => secondary({ 'retry-after': '1' }),
      () => new Response('{"data":{"ok":true}}', { status: 200 }),
    ])

    await expect(client.graphql('mutation { ok }')).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('GraphQL con RATE_LIMITED sale como transient', async () => {
    const { client } = clientWith([
      () =>
        new Response('{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}', {
          status: 200,
        }),
    ])

    const error = await failure(client.graphql('query { x }'))
    expect(error).toBeInstanceOf(GithubApiError)
    expect(error.transient).toBe(true)
  })
})

describe('GithubClient — 5xx y red', () => {
  it('reintenta un 502 de una lectura', async () => {
    const { client, fetchImpl } = clientWith([
      () => new Response('bad gateway', { status: 502 }),
      () => new Response('{}', { status: 200 }),
    ])

    await client.requestJson('/x')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('no reintenta un 502 de una escritura, pero el error es transient', async () => {
    const { client, fetchImpl } = clientWith([() => new Response('bad gateway', { status: 502 })])

    const error = await failure(client.requestJson('/x', { method: 'POST', body: '{}' }))
    expect(error.transient).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('un fallo de red sale como GithubApiError transient', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const client = new GithubClient({
      auth: auth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    const error = await failure(client.requestJson('/x'))
    expect(error).toBeInstanceOf(GithubApiError)
    expect(error.transient).toBe(true)
  })
})

describe('GithubClient — compuerta por identidad', () => {
  it('un límite que recibe un cliente frena al resto de los de la misma identidad', async () => {
    const clock = fakeClock()
    const calls: string[] = []
    let first = true
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(`${new URL(url).pathname}@${clock.now()}`)
      if (first) {
        first = false
        return secondary({ 'retry-after': '10' })
      }
      return new Response('{}', { status: 200 })
    })
    const opts = {
      auth: auth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      random: () => 0,
    }
    const a = new GithubClient(opts)
    const b = new GithubClient(opts)

    await a.requestJson('/a')
    await b.requestJson('/b')
    // El reintento de /a y el /b salen recién pasada la pausa.
    expect(calls).toEqual(['/a@1000000', '/a@1010000', '/b@1010000'])
  })

  it('una ráfaga de mutaciones sale sin esperar hasta writeBurst, después a una por writeGapMs', async () => {
    const clock = fakeClock()
    const starts: number[] = []
    const fetchImpl = vi.fn(async () => {
      starts.push(clock.now() - 1_000_000)
      return new Response('{"data":{}}', { status: 200 })
    })
    const client = new GithubClient({
      auth: auth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
      writeBurst: 2,
      writeGapMs: 1000,
    })

    await Promise.all(['a', 'b', 'c', 'd'].map((field) => client.graphql(`mutation { ${field} }`)))
    expect(starts).toEqual([0, 0, 1000, 2000])
  })

  it('las mutaciones van de a una aunque haya balde', async () => {
    let inFlight = 0
    let peak = 0
    const fetchImpl = vi.fn(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight--
      return new Response('{"data":{}}', { status: 200 })
    })
    const client = new GithubClient({
      auth: auth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    await Promise.all([client.graphql('mutation { a }'), client.graphql('mutation { b }')])
    expect(peak).toBe(1)
  })

  it('las queries no esperan el aire de las escrituras', async () => {
    const clock = fakeClock()
    const fetchImpl = vi.fn(async () => new Response('{"data":{}}', { status: 200 }))
    const client = new GithubClient({
      auth: auth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      clock,
    })

    await Promise.all([client.graphql('query { a }'), client.graphql('query { b }')])
    expect(clock.slept).toEqual([])
  })

  it('respeta maxConcurrent', async () => {
    let inFlight = 0
    let peak = 0
    const fetchImpl = vi.fn(async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return new Response('{}', { status: 200 })
    })
    const client = new GithubClient({
      auth: auth(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxConcurrent: 2,
    })

    await Promise.all(Array.from({ length: 6 }, (_, i) => client.requestJson(`/x/${i}`)))
    expect(peak).toBe(2)
  })
})
