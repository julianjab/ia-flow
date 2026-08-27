import { Storage } from 'happy-dom'
import { describe, expect, it } from 'vitest'

// Regresión de #85: en Node >=22 los getters globales de storage ganan sobre
// la inyección de happy-dom y toda la suite que toca `localStorage` se cae con
// "Cannot read properties of undefined". Si alguien saca el setupFiles del
// vitest.config, esto se pone rojo antes que las decenas de tests de features.
describe('globals de storage bajo happy-dom', () => {
  for (const key of ['localStorage', 'sessionStorage'] as const) {
    it(`\`${key}\` global es el de happy-dom, no el de Node`, () => {
      expect(globalThis[key]).toBeInstanceOf(Storage)
    })

    it(`\`${key}\` global guarda y limpia`, () => {
      globalThis[key].setItem('ia-flow:probe', 'ok')
      expect(globalThis[key].getItem('ia-flow:probe')).toBe('ok')
      globalThis[key].clear()
      expect(globalThis[key].getItem('ia-flow:probe')).toBeNull()
    })
  }
})
