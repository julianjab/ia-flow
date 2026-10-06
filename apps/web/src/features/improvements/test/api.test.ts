import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dismissImprovement, getImprovements, openImprovement } from '../api'
import { proposal } from './fixtures'

const get = vi.spyOn(axios, 'get')
const post = vi.spyOn(axios, 'post')

describe('api de mejoras', () => {
  afterEach(() => vi.clearAllMocks())

  it('getImprovements valida la lista y pide las abiertas por default', async () => {
    get.mockResolvedValueOnce({ status: 200, data: { items: [proposal()] } })
    const list = await getImprovements()
    expect(list?.items).toHaveLength(1)
    expect(get.mock.calls[0]?.[1]).toMatchObject({ params: { status: 'open' } })
  })

  it('un runner viejo (404) o que no las guarda (501) es "no hay", no un error', async () => {
    get.mockResolvedValueOnce({ status: 404, data: {} })
    expect(await getImprovements()).toBeNull()
    get.mockResolvedValueOnce({ status: 501, data: {} })
    expect(await getImprovements()).toBeNull()
  })

  it('otro error se lanza', async () => {
    get.mockResolvedValueOnce({ status: 401, data: {} })
    await expect(getImprovements()).rejects.toThrow(/401/)
  })

  it('open firma con x-github-token y devuelve el resultado', async () => {
    const p = proposal({ status: 'opened', issue_url: 'https://github.com/acme/api/issues/1' })
    post.mockResolvedValueOnce({ status: 200, data: { ok: true, message: 'abierto', proposal: p } })
    const result = await openImprovement('imp-1', 'gho_1')
    expect(result.proposal?.issue_url).toBe(p.issue_url)
    expect(post.mock.calls[0]?.[0]).toBe('/api/improvements/imp-1/open')
    expect(post.mock.calls[0]?.[2]).toMatchObject({ headers: { 'x-github-token': 'gho_1' } })
  })

  it('un rechazo con cuerpo ok:false se devuelve con su mensaje, no se lanza', async () => {
    post.mockResolvedValueOnce({ status: 409, data: { ok: false, message: 'ya estaba decidida' } })
    expect(await dismissImprovement('imp-1', 'gho_1')).toEqual({
      ok: false,
      message: 'ya estaba decidida',
    })
  })

  it('una respuesta sin esa forma se lanza', async () => {
    post.mockResolvedValueOnce({ status: 404, data: 'nope' })
    await expect(openImprovement('imp-1', 't')).rejects.toThrow(/404/)
  })
})
