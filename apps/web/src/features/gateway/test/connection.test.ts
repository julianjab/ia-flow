import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GATEWAY_URL,
  normalizeGatewayUrl,
  resolveGatewayUrl,
  setGatewayUrl,
} from '../connection'

function withSearch(search: string): void {
  window.history.replaceState({}, '', `/gateway.html${search}`)
}

beforeEach(() => {
  window.localStorage.clear()
  withSearch('')
})

describe('normalizeGatewayUrl', () => {
  it('recorta y saca la barra final — todas las rutas se concatenan como `${base}/v1/...`', () => {
    expect(normalizeGatewayUrl('  http://localhost:3002/  ')).toBe('http://localhost:3002')
    expect(normalizeGatewayUrl('http://localhost:3002///')).toBe('http://localhost:3002')
  })
})

describe('resolveGatewayUrl', () => {
  it('sin nada, el default', () => {
    expect(resolveGatewayUrl()).toBe(DEFAULT_GATEWAY_URL)
  })

  it('la query gana — es lo que pone la app de Electron al abrir la ventana', () => {
    withSearch('?url=http://127.0.0.1:4002/')
    expect(resolveGatewayUrl()).toBe('http://127.0.0.1:4002')
  })

  it('lo resuelto queda guardado, así un reload sin query sigue en el mismo gateway', () => {
    withSearch('?url=http://127.0.0.1:4002')
    resolveGatewayUrl()
    withSearch('')
    expect(resolveGatewayUrl()).toBe('http://127.0.0.1:4002')
  })

  it('lo elegido a mano pisa lo guardado', () => {
    setGatewayUrl('http://otra-maquina:3002/')
    expect(resolveGatewayUrl()).toBe('http://otra-maquina:3002')
  })
})
