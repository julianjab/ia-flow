import axios from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { explainTask, getInbox, getTaskDetail, postTaskAction, taskPath } from '../api'
import { detail, inbox, item } from './fixtures'

const get = vi.spyOn(axios, 'get')
const post = vi.spyOn(axios, 'post')

describe('taskPath', () => {
  it('owner/repo#n → /api/tasks/:owner/:repo/:number', () => {
    expect(taskPath('acme/api#7')).toBe('/api/tasks/acme/api/7')
  })

  it('una ref mal formada falla fuerte, no pega a una URL rara', () => {
    expect(() => taskPath('acme#7')).toThrow(/inválida/)
    expect(() => taskPath('a/b#x')).toThrow(/inválida/)
  })
})

describe('api de la bandeja', () => {
  afterEach(() => vi.clearAllMocks())

  it('getInbox valida la respuesta con el schema del contrato', async () => {
    get.mockResolvedValueOnce({ data: inbox([item()]) })
    const result = await getInbox()
    expect(result.items).toHaveLength(1)
    expect(get).toHaveBeenCalledWith('/api/inbox', { params: undefined })

    get.mockResolvedValueOnce({ data: { items: 'nope' } })
    await expect(getInbox()).rejects.toThrow()
  })

  it('getInbox pasa ?project cuando se pide uno', async () => {
    get.mockResolvedValueOnce({ data: inbox([]) })
    await getInbox('core')
    expect(get).toHaveBeenCalledWith('/api/inbox', { params: { project: 'core' } })
  })

  it('getTaskDetail pide la ejecución elegida y valida el detalle', async () => {
    const it = item()
    get.mockResolvedValueOnce({ data: detail(it) })
    const result = await getTaskDetail(it.ref, 'ex9')
    expect(result.item.ref).toBe(it.ref)
    expect(get).toHaveBeenCalledWith('/api/tasks/acme/api/7', { params: { execution: 'ex9' } })
  })

  it('explainTask manda la ref (y el evento si lo hay) como params', async () => {
    get.mockResolvedValueOnce({
      data: {
        ref: 'acme/api#7',
        event: { type: 'issue.unblocked', summary: {} },
        source: 'synthetic',
        decisions: [],
      },
    })
    const result = await explainTask('acme/api#7', 'issue.unblocked')
    expect(result.source).toBe('synthetic')
    expect(get).toHaveBeenCalledWith('/api/explain', {
      params: { ref: 'acme/api#7', event: 'issue.unblocked' },
    })
  })

  it('postTaskAction lleva el token de GitHub del usuario y SÓLO ahí', async () => {
    post.mockResolvedValueOnce({
      status: 200,
      data: { ok: true, message: 'Mergeado', github_login: 'ada' },
    })
    const result = await postTaskAction('acme/api#7', { action: 'merge' }, 'gho_abc')
    expect(result).toEqual({ ok: true, message: 'Mergeado', github_login: 'ada' })
    const [url, body, config] = post.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ]
    expect(url).toBe('/api/tasks/acme/api/7/actions')
    expect(body).toEqual({ action: 'merge' })
    expect(config.headers).toEqual({ 'x-github-token': 'gho_abc' })
  })

  it('un rechazo del runner (ok:false) se devuelve para mostrarlo; una respuesta ilegible se lanza', async () => {
    post.mockResolvedValueOnce({
      status: 403,
      data: { ok: false, message: 'Sin permisos de merge' },
    })
    expect(await postTaskAction('acme/api#7', { action: 'merge' }, 't')).toMatchObject({
      ok: false,
      message: 'Sin permisos de merge',
    })

    post.mockResolvedValueOnce({ status: 404, data: '<html>' })
    await expect(postTaskAction('acme/api#7', { action: 'merge' }, 't')).rejects.toThrow(/404/)
  })
})
