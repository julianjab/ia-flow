import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshGithubToken } from '../api'

const post = vi.spyOn(axios, 'post')

describe('refreshGithubToken', () => {
  afterEach(() => vi.clearAllMocks())

  it('devuelve el par nuevo', async () => {
    const token = { access_token: 'ghu_new', login: 'julian', refresh_token: 'ghr_new' }
    post.mockResolvedValueOnce({ status: 200, data: token })
    expect(await refreshGithubToken('ghr_old')).toEqual(token)
  })

  it('el 401 de GitHub es null: hay que volver a loguearse', async () => {
    post.mockResolvedValueOnce({
      status: 401,
      data: { error: 'GitHub no renovó el token: expired', code: 'github_refresh_rejected' },
    })
    expect(await refreshGithubToken('ghr_old')).toBeNull()
  })

  it('un runner viejo, sin code, sigue cerrando la sesión con su 401', async () => {
    post.mockResolvedValueOnce({ status: 401, data: { error: 'GitHub no renovó el token' } })
    expect(await refreshGithubToken('ghr_old')).toBeNull()
  })

  it('el 401 del token del runner se lanza: no cierra la sesión de GitHub', async () => {
    post.mockResolvedValueOnce({
      status: 401,
      data: { error: 'token inválido', code: 'runner_token' },
    })
    await expect(refreshGithubToken('ghr_old')).rejects.toThrow(/x-ia-flow-token/)
  })
})
