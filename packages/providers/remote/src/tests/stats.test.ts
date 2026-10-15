import { afterEach, describe, expect, it } from 'vitest'
import { HostClient } from '../HostClient.js'
import { makeHub, output, post, RUNNER, TOKEN, until, wire } from './fixtures.js'

const hosts: HostClient[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
})

function host(fetchImpl: typeof fetch, stats: () => Record<string, unknown>, statsEveryMs = 20) {
  const client = new HostClient({
    runnerUrl: RUNNER,
    token: TOKEN,
    name: 'laptop',
    maxConcurrent: 2,
    accepts: [],
    run: async () => output(),
    fetchImpl,
    retryMs: 10,
    stats,
    statsEveryMs,
  })
  hosts.push(client)
  client.start()
  return client
}

const auth = { authorization: `Bearer ${TOKEN}` }

describe('los recursos del host', () => {
  it('se mandan al suscribirse y cada tanto: el runner los muestra con su host', async () => {
    const { hub } = makeHub()
    let worktrees = 1
    host(wire(hub), () => ({ worktrees: worktrees++ }))
    await until(() => hub.list()[0]?.stats !== undefined)
    const [info] = hub.list()
    expect(info).toMatchObject({ name: 'laptop', maxConcurrent: 2, running: 0 })
    expect(info?.statsAt).toEqual(expect.any(String))
    await until(() => ((hub.list()[0]?.stats?.worktrees as number) ?? 0) >= 3)
  })

  it('sin `stats` no se manda nada', async () => {
    const { hub } = makeHub()
    const client = new HostClient({
      runnerUrl: RUNNER,
      token: TOKEN,
      name: 'laptop',
      maxConcurrent: 1,
      accepts: [],
      run: async () => output(),
      fetchImpl: wire(hub),
      retryMs: 10,
    })
    hosts.push(client)
    client.start()
    await until(() => hub.list().length === 1)
    expect(hub.list()[0]?.stats).toBeUndefined()
  })

  it('un runner anterior a /stats contesta 404: el host sigue trabajando y deja de mandarlos', async () => {
    const { hub } = makeHub()
    let statsCalls = 0
    const old = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/stats')) {
        statsCalls += 1
        return new Response(JSON.stringify({ error: 'ruta desconocida' }), { status: 404 })
      }
      return wire(hub)(input, init)
    }) as typeof fetch
    host(old, () => ({ worktrees: 0 }), 5)
    await until(() => statsCalls === 1 && hub.list().length === 1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(statsCalls).toBe(1)
    expect(hub.list()[0]?.stats).toBeUndefined()
  })

  it('una sesión desconocida es un 404; un body que no es un objeto, un 400', async () => {
    const { hub } = makeHub()
    const unknown = await hub.fetch(
      new Request(`${RUNNER}/v1/hosts/nope/stats`, { method: 'POST', headers: auth, body: '{}' }),
    )
    expect(unknown?.status).toBe(404)

    const subscribed = await hub.fetch(
      new Request(`${RUNNER}/v1/hosts/subscribe`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'laptop' }),
      }),
    )
    const { session } = (await (subscribed as Response).json()) as { session: string }
    const bad = await hub.fetch(
      new Request(`${RUNNER}/v1/hosts/${session}/stats`, {
        method: 'POST',
        headers: auth,
        body: '[1]',
      }),
    )
    expect(bad?.status).toBe(400)
  })

  it('sin el token de hosts, no', async () => {
    const { hub } = makeHub()
    const res = await post(hub, `${RUNNER}/v1/hosts/x/stats`, { worktrees: 1 })
    expect(res.status).toBe(401)
  })
})
