import { describe, expect, it } from 'vitest'

/**
 * Guarda del entorno de tests (`apps/web/vitest.environment.ts`). Cuatro archivos
 * de features rompían en su `beforeEach` porque `localStorage` llegaba
 * `undefined` — el global de Node tapaba el de happy-dom. Un fallo acá dice
 * "el entorno está roto" en vez de repartir el mismo error por media suite.
 */
describe('entorno de tests — Web Storage', () => {
  it('`localStorage` es el del DOM, no el global vacío de Node', () => {
    expect(localStorage).toBeDefined()
    expect(localStorage).toBe(window.localStorage)

    localStorage.setItem('ia-flow:probe', 'ok')
    expect(localStorage.getItem('ia-flow:probe')).toBe('ok')

    localStorage.clear()
    expect(localStorage.getItem('ia-flow:probe')).toBeNull()
  })

  it('`sessionStorage` también está poblado', () => {
    expect(sessionStorage).toBeDefined()
    expect(sessionStorage).toBe(window.sessionStorage)

    sessionStorage.setItem('ia-flow:probe', 'ok')
    expect(sessionStorage.getItem('ia-flow:probe')).toBe('ok')

    sessionStorage.clear()
    expect(sessionStorage.getItem('ia-flow:probe')).toBeNull()
  })
})
