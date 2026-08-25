import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GATEWAY_URL,
  listGateways,
  normalizeGatewayUrl,
  removeGateway,
  resolveGateway,
  upsertGateway,
} from '../connection'

function withSearch(search: string): void {
  window.history.replaceState({}, '', `/gateway.html${search}`)
}

beforeEach(() => {
  window.localStorage.clear()
  withSearch('')
})

describe('normalizeGatewayUrl', () => {
  it('recorta y saca la barra final — las rutas se concatenan como `${base}/v1/...`', () => {
    expect(normalizeGatewayUrl('  http://localhost:3002/  ')).toBe('http://localhost:3002')
    expect(normalizeGatewayUrl('http://localhost:3002///')).toBe('http://localhost:3002')
  })
})

describe('resolveGateway', () => {
  it('sin nada, el default — y queda dado de alta para poder elegirlo después', () => {
    expect(resolveGateway().url).toBe(DEFAULT_GATEWAY_URL)
    expect(listGateways().map((e) => e.url)).toEqual([DEFAULT_GATEWAY_URL])
  })

  it('la query gana — es lo que pone la app de Electron al abrir la ventana', () => {
    withSearch('?url=http://127.0.0.1:4002/')
    expect(resolveGateway().url).toBe('http://127.0.0.1:4002')
  })

  it('lo resuelto queda seleccionado, así un reload sin query sigue en el mismo', () => {
    withSearch('?url=http://127.0.0.1:4002')
    resolveGateway()
    withSearch('')
    expect(resolveGateway().url).toBe('http://127.0.0.1:4002')
  })

  it('toma el token que el preload de Electron dejó en la clave legacy', () => {
    window.localStorage.setItem('ia-flow:gateway:token', 'del-preload')
    expect(resolveGateway().token).toBe('del-preload')
  })

  it('migra la elección suelta de la pantalla vieja a la lista', () => {
    window.localStorage.setItem('ia-flow:gateway:url', 'http://viejo:3002')
    window.localStorage.setItem('ia-flow:gateway:token', 'viejo-token')
    expect(resolveGateway()).toEqual({ url: 'http://viejo:3002', token: 'viejo-token' })
  })
})

describe('la lista de gateways', () => {
  it('recuerda varios y pone el último usado adelante', () => {
    upsertGateway('http://a:3002', 'ta')
    upsertGateway('http://b:3002', 'tb')
    expect(listGateways().map((e) => e.url)).toEqual(['http://b:3002', 'http://a:3002'])
  })

  it('un token vacío NO pisa el guardado — reconectar sin re-tipearlo lo conserva', () => {
    upsertGateway('http://a:3002', 'secreto')
    upsertGateway('http://a:3002', '')
    expect(listGateways()[0]?.token).toBe('secreto')
  })

  it('olvidar el seleccionado deja seleccionado a otro, no a nada', () => {
    upsertGateway('http://a:3002', 'ta')
    upsertGateway('http://b:3002', 'tb')
    removeGateway('http://b:3002')
    expect(resolveGateway().url).toBe('http://a:3002')
  })

  it('un JSON roto no deja la consola inservible', () => {
    window.localStorage.setItem('ia-flow:gateway:list', '{no json')
    expect(listGateways()).toEqual([])
  })
})
