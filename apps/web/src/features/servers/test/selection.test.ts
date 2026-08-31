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

  it('el tipo del elegido sobrevive al reload', async () => {
    // Es lo que decide qué navegación dibuja el shell, y se decide ANTES de
    // que ninguna request haya vuelto. Re-derivarlo costaría una sonda contra
    // un proceso que puede estar caído — y un agent-host que no contesta no
    // deja de ser un agent-host.
    const first = await import('../selection')
    first.selectServer('http://localhost:3012', 'tok', 'agent-host')

    vi.resetModules()
    const second = await import('../selection')
    second.restoreSelectedServer()

    expect(second.getSelectedKind()).toBe('agent-host')
  })

  it('una elección guardada por una versión sin tipo cuenta como server', async () => {
    // Es lo que había antes de que existiera el campo: sin él, un reload
    // después de actualizar habría dejado al operador sin menú.
    localStorage.setItem('ia-flow:servers:selected', 'http://localhost:3001')

    const { restoreSelectedServer, getSelectedKind } = await import('../selection')
    restoreSelectedServer()

    expect(getSelectedKind()).toBe('server')
  })
})
