import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_AGENT_HOST_URL,
  listAgentHosts,
  normalizeAgentHostUrl,
  removeAgentHost,
  resolveAgentHost,
  upsertAgentHost,
} from '../connection'

function withSearch(search: string): void {
  window.history.replaceState({}, '', `/agent-host.html${search}`)
}

beforeEach(() => {
  window.localStorage.clear()
  withSearch('')
})

describe('normalizeAgentHostUrl', () => {
  it('recorta y saca la barra final — las rutas se concatenan como `${base}/v1/...`', () => {
    expect(normalizeAgentHostUrl('  http://localhost:3002/  ')).toBe('http://localhost:3002')
    expect(normalizeAgentHostUrl('http://localhost:3002///')).toBe('http://localhost:3002')
  })
})

describe('resolveAgentHost', () => {
  it('sin nada, el default — y queda dado de alta para poder elegirlo después', () => {
    expect(resolveAgentHost().url).toBe(DEFAULT_AGENT_HOST_URL)
    expect(listAgentHosts().map((e) => e.url)).toEqual([DEFAULT_AGENT_HOST_URL])
  })

  it('la query gana — es lo que pone la app de Electron al abrir la ventana', () => {
    withSearch('?url=http://127.0.0.1:4002/')
    expect(resolveAgentHost().url).toBe('http://127.0.0.1:4002')
  })

  it('lo resuelto queda seleccionado, así un reload sin query sigue en el mismo', () => {
    withSearch('?url=http://127.0.0.1:4002')
    resolveAgentHost()
    withSearch('')
    expect(resolveAgentHost().url).toBe('http://127.0.0.1:4002')
  })
})

describe('la lista de agent-hosts', () => {
  it('recuerda varios y pone el último usado adelante', () => {
    upsertAgentHost('http://a:3002', 'ta')
    upsertAgentHost('http://b:3002', 'tb')
    expect(listAgentHosts().map((e) => e.url)).toEqual(['http://b:3002', 'http://a:3002'])
  })

  it('un token vacío NO pisa el guardado — reconectar sin re-tipearlo lo conserva', () => {
    upsertAgentHost('http://a:3002', 'secreto')
    upsertAgentHost('http://a:3002', '')
    expect(listAgentHosts()[0]?.token).toBe('secreto')
  })

  it('olvidar el seleccionado deja seleccionado a otro, no a nada', () => {
    upsertAgentHost('http://a:3002', 'ta')
    upsertAgentHost('http://b:3002', 'tb')
    removeAgentHost('http://b:3002')
    expect(resolveAgentHost().url).toBe('http://a:3002')
  })

  it('un JSON roto no deja la consola inservible', () => {
    window.localStorage.setItem('ia-flow:agent-host:list', '{no json')
    expect(listAgentHosts()).toEqual([])
  })
})
