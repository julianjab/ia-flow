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

  it('el tipo del elegido sobrevive al reload', async () => {
    // Se decide ANTES de que ninguna request haya vuelto. Re-derivarlo costaría
    // una sonda contra un proceso que puede estar caído.
    const first = await import('../selection')
    first.selectServer('http://localhost:3012', 'tok', 'unknown')

    vi.resetModules()
    const second = await import('../selection')
    second.restoreSelectedServer()

    expect(second.getSelectedKind()).toBe('unknown')
  })

  it('una elección guardada sin tipo cuenta como runner', async () => {
    localStorage.setItem('ia-flow:servers:selected', 'http://localhost:3001')

    const { restoreSelectedServer, getSelectedKind } = await import('../selection')
    restoreSelectedServer()

    expect(getSelectedKind()).toBe('runner')
  })

  it('el login de GitHub del elegido sobrevive al reload', async () => {
    const first = await import('../selection')
    first.selectServer('http://localhost:3020', 'tok', 'runner', { token: 'gho_x', login: 'ada' })

    vi.resetModules()
    const second = await import('../selection')
    second.restoreSelectedServer()

    expect(second.getSelectedGithub()).toEqual({ token: 'gho_x', login: 'ada' })
    second.setSelectedGithub(null)
    expect(second.getSelectedGithub()).toBeNull()
    expect(localStorage.getItem('ia-flow:servers:selected-github')).toBeNull()
  })

  it('un login roto en el storage es "sin sesión", no una excepción', async () => {
    localStorage.setItem('ia-flow:servers:selected', 'http://localhost:3020')
    localStorage.setItem('ia-flow:servers:selected-github', '{"token":1}')
    const { restoreSelectedServer, getSelectedGithub } = await import('../selection')
    restoreSelectedServer()
    expect(getSelectedGithub()).toBeNull()
  })
})
