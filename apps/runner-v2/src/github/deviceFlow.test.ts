import { describe, expect, it } from 'bun:test'
import { DeviceFlow, REFRESH_REPLAY_MS, RefreshRejectedError } from './deviceFlow.js'

/** GitHub de mentira: `/login/oauth/access_token` contesta `token` (y anota el body), `/user`
 *  contesta el login, o falla mientras `user.fails` sea mayor que cero. */
function github(token: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = []
  const user = { fails: 0 }
  const clock = { now: 0 }
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/user')) {
      if (user.fails-- > 0) return new Response('boom', { status: 502 })
      return Response.json({ login: 'julian' })
    }
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json(token)
  }) as typeof fetch
  const flow = new DeviceFlow({ clientId: 'Iv1.x', fetchImpl, now: () => clock.now })
  return { flow, bodies, user, clock }
}

const ROTATING = {
  access_token: 'ghu_new',
  expires_in: 28800,
  refresh_token: 'ghr_new',
  refresh_token_expires_in: 15897600,
}

describe('DeviceFlow', () => {
  it('an OAuth App asks for its scopes; without scopes, none are sent (a GitHub App ignores them)', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({
        device_code: 'dc',
        user_code: 'AB-CD',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
      })
    }) as typeof fetch
    await new DeviceFlow({
      clientId: 'Ov23x',
      scopes: ' repo project read:org ',
      fetchImpl,
    }).start()
    await new DeviceFlow({ clientId: 'Iv1.x', fetchImpl }).start()
    expect(bodies).toEqual([
      { client_id: 'Ov23x', scope: 'repo project read:org' },
      { client_id: 'Iv1.x' },
    ])
  })

  it('the login brings what it takes to renew it', async () => {
    const { flow } = github(ROTATING)
    expect(await flow.poll('dc')).toEqual({ status: 'ok', login: 'julian', ...ROTATING })
  })

  it('a token that does not expire comes without a refresh token', async () => {
    const { flow } = github({ access_token: 'gho_x' })
    expect(await flow.poll('dc')).toEqual({ status: 'ok', access_token: 'gho_x', login: 'julian' })
  })

  it('refresh trades the refresh token for a new pair, with no client secret', async () => {
    const { flow, bodies } = github(ROTATING)
    expect(await flow.refresh('ghr_old')).toEqual({ login: 'julian', ...ROTATING })
    expect(bodies).toEqual([
      { client_id: 'Iv1.x', grant_type: 'refresh_token', refresh_token: 'ghr_old' },
    ])
  })

  it('a refresh token GitHub no longer takes is a RefreshRejectedError', async () => {
    const { flow } = github({ error: 'bad_refresh_token', error_description: 'expired' })
    const refresh = flow.refresh('ghr_old')
    await expect(refresh).rejects.toBeInstanceOf(RefreshRejectedError)
    await expect(flow.refresh('ghr_old')).rejects.toThrow(/expired/)
  })

  it('the same refresh token again (the answer got lost) gets the same pair, without GitHub', async () => {
    const { flow, bodies, clock } = github(ROTATING)
    const first = await flow.refresh('ghr_old')
    clock.now += REFRESH_REPLAY_MS - 1
    expect(await flow.refresh('ghr_old')).toEqual(first)
    expect(bodies).toHaveLength(1)
  })

  it('two renewals with the same refresh token at once go to GitHub once', async () => {
    const { flow, bodies } = github(ROTATING)
    const [a, b] = await Promise.all([flow.refresh('ghr_old'), flow.refresh('ghr_old')])
    expect(a).toEqual(b)
    expect(bodies).toHaveLength(1)
  })

  it('past the replay window the refresh token goes to GitHub again', async () => {
    const { flow, bodies, clock } = github(ROTATING)
    await flow.refresh('ghr_old')
    clock.now += REFRESH_REPLAY_MS + 1
    await flow.refresh('ghr_old')
    expect(bodies).toHaveLength(2)
  })

  it('if the login lookup fails after the exchange, the retry reuses the exchange', async () => {
    const { flow, bodies, user } = github(ROTATING)
    user.fails = 1
    await expect(flow.refresh('ghr_old')).rejects.toThrow(/502/)
    expect(await flow.refresh('ghr_old')).toEqual({ login: 'julian', ...ROTATING })
    expect(bodies).toHaveLength(1)
  })

  it('a rejected refresh token is not remembered: the retry asks GitHub again', async () => {
    const { flow, bodies } = github({ error: 'bad_refresh_token' })
    await expect(flow.refresh('ghr_old')).rejects.toBeInstanceOf(RefreshRejectedError)
    await expect(flow.refresh('ghr_old')).rejects.toBeInstanceOf(RefreshRejectedError)
    expect(bodies).toHaveLength(2)
  })
})
