import axios from 'axios'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('selección de server', () => {
  beforeEach(() => {
    localStorage.clear()
    axios.defaults.baseURL = undefined
    vi.resetModules()
  })

  it('elegir un server manda TODAS las llamadas relativas a ese origen', async () => {
    const { selectServer } = await import('../selection')
    selectServer('http://localhost:3020')
    expect(axios.defaults.baseURL).toBe('http://localhost:3020')
  })

  it('volver al proxy limpia el baseURL — las rutas relativas vuelven a Vite', async () => {
    const { selectServer } = await import('../selection')
    selectServer('http://localhost:3020')
    selectServer(null)
    expect(axios.defaults.baseURL).toBeUndefined()
  })

  it('la elección sobrevive al reload', async () => {
    const first = await import('../selection')
    first.selectServer('http://localhost:3020')

    vi.resetModules()
    const second = await import('../selection')

    expect(second.restoreSelectedServer()).toBe('http://localhost:3020')
    expect(axios.defaults.baseURL).toBe('http://localhost:3020')
  })

  it('el WS apunta al server elegido, no al que sirve la página', async () => {
    const { selectServer, wsOrigin } = await import('../selection')
    selectServer('http://localhost:3020')
    expect(wsOrigin()).toBe('localhost:3020')
  })

  it('sin elección, el WS sigue saliendo por el host de la página', async () => {
    const { restoreSelectedServer, wsOrigin } = await import('../selection')
    restoreSelectedServer()
    expect(wsOrigin()).toBe(window.location.host)
  })
})
