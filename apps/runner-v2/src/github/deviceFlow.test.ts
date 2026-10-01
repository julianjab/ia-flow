import { describe, expect, it } from 'bun:test'
import { DeviceFlow, RefreshRejectedError } from './deviceFlow.js'

/** GitHub de mentira: `/login/oauth/access_token` contesta `token` (y anota el body), `/user`
 *  contesta el login. */
function github(token: Record<string, unknown>) {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/user')) return Response.json({ login: 'julian' })
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json(token)
  }) as typeof fetch
  return { flow: new DeviceFlow({ clientId: 'Iv1.x', fetchImpl }), bodies }
}

const ROTATING = {
  access_token: 'ghu_new',
  expires_in: 28800,
  refresh_token: 'ghr_new',
  refresh_token_expires_in: 15897600,
}

describe('DeviceFlow', () => {
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
})
