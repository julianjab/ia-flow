import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * El token del server elegido NO puede salir hacia otro host.
 *
 * Estos tests existen por dos fugas concretas que tuvo la primera versión, que
 * aplicaba el token como `axios.defaults.headers.common`:
 *
 *  - el sondeo de la pantalla de servers le pega a CADA URL declarada —hosts
 *    arbitrarios que el usuario tipeó— y el default se mergeaba en todas.
 *  - `axios.create()` hereda los defaults, así que el cliente del gateway
 *    mandaba también el token del server de ia-flow.
 */
describe('el token sólo viaja al server elegido', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
    axios.interceptors.request.clear()
  })

  /** Corre los interceptores sobre una config, sin tocar la red. */
  async function headersFor(config: {
    baseURL?: string
    url: string
  }): Promise<Record<string, unknown>> {
    const handlers = (
      axios.interceptors.request as unknown as {
        handlers: { fulfilled: (c: unknown) => unknown }[]
      }
    ).handlers.filter(Boolean)
    let cfg: Record<string, unknown> = {
      ...config,
      headers: axios.AxiosHeaders.from({}),
    }
    for (const h of handlers) cfg = (await h.fulfilled(cfg)) as Record<string, unknown>
    return (cfg.headers as { toJSON(): Record<string, unknown> }).toJSON()
  }

  it('lo manda cuando la request va al server elegido', async () => {
    const { selectServer } = await import('../selection')
    selectServer('http://localhost:3001', 'secreto')

    const h = await headersFor({ baseURL: 'http://localhost:3001', url: '/api/projects' })

    expect(h['x-ia-flow-token']).toBe('secreto')
  })

  it('NO lo manda al sondear otro host — la fuga que motivó el interceptor', async () => {
    const { selectServer } = await import('../selection')
    selectServer('http://localhost:3001', 'secreto')

    // Lo que hace `scan()`: una URL absoluta a cada server declarado.
    const h = await headersFor({ url: 'http://un-host-ajeno:9999/api/projects' })

    expect(h['x-ia-flow-token']).toBeUndefined()
  })

  it('NO lo manda al gateway, que tiene su propia credencial', async () => {
    const { selectServer } = await import('../selection')
    selectServer('http://localhost:3001', 'secreto')

    // El cliente del gateway apunta a otro origen con su propio Bearer. Antes
    // llevaba los dos, y el guard del gateway prefiere `x-ia-flow-token` — o
    // sea que además de filtrar, daba 401 con la credencial correcta.
    const h = await headersFor({ baseURL: 'http://localhost:3002', url: '/v1/provider' })

    expect(h['x-ia-flow-token']).toBeUndefined()
  })

  it('no pisa un header puesto explícitamente por quien llama', async () => {
    const { selectServer } = await import('../selection')
    selectServer('http://localhost:3001', 'del-selection')

    const handlers = (
      axios.interceptors.request as unknown as {
        handlers: { fulfilled: (c: unknown) => unknown }[]
      }
    ).handlers.filter(Boolean)
    let cfg: Record<string, unknown> = {
      baseURL: 'http://localhost:3001',
      url: '/api/projects',
      headers: axios.AxiosHeaders.from({ 'x-ia-flow-token': 'del-llamador' }),
    }
    for (const h of handlers) cfg = (await h.fulfilled(cfg)) as Record<string, unknown>

    expect((cfg.headers as { toJSON(): Record<string, unknown> }).toJSON()['x-ia-flow-token']).toBe(
      'del-llamador',
    )
  })

  it('cambiar a un server sin token deja de mandarlo', async () => {
    const { selectServer } = await import('../selection')
    selectServer('http://localhost:3001', 'secreto')
    selectServer('http://localhost:3005', undefined)

    const h = await headersFor({ baseURL: 'http://localhost:3005', url: '/api/projects' })

    expect(h['x-ia-flow-token']).toBeUndefined()
  })
})
