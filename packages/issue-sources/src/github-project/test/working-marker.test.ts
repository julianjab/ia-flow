import { describe, expect, test } from 'bun:test'
import { DEFAULT_WORKING_MARKER, isMarkedWorking, parseWorkingMarker } from '../working-marker.js'

describe('parseWorkingMarker', () => {
  test('ausente cae al default histórico (Working=Yes)', () => {
    expect(parseWorkingMarker(undefined)).toEqual(DEFAULT_WORKING_MARKER)
  })

  test('null es "este board no usa marca"', () => {
    expect(parseWorkingMarker(null)).toBeNull()
  })

  test('acepta un campo propio del board', () => {
    expect(parseWorkingMarker({ field: 'Agente', on: 'corriendo' })).toEqual({
      field: 'Agente',
      on: 'corriendo',
      off: '',
    })
  })

  test('rechaza Status: applyTransition ya escribe ese campo en cada outcome', () => {
    expect(() => parseWorkingMarker({ field: 'status', on: 'Doing' })).toThrow(/Status/)
  })

  test('rechaza una forma inválida con un mensaje accionable', () => {
    expect(() => parseWorkingMarker({ field: 'Working' })).toThrow(/workingMarker inválido/)
  })

  // En Labels no hay "vaciar": sin un `off` explícito la marca quedaría puesta
  // para siempre y todo scan posterior saltearía el issue.
  test('exige off en un campo multi-valor', () => {
    expect(() => parseWorkingMarker({ field: 'Labels', on: '+working' })).toThrow(/off/)
  })

  test('firma los tokens de un campo multi-valor', () => {
    expect(
      parseWorkingMarker({ field: 'Labels', on: 'ia-flow:working', off: '-ia-flow:working' }),
    ).toEqual({ field: 'Labels', on: '+ia-flow:working', off: '-ia-flow:working' })
  })
})

describe('isMarkedWorking', () => {
  const labelMarker = { field: 'Labels', on: '+ia-flow:working', off: '-ia-flow:working' }

  test('sin marker declarado, nada está marcado', () => {
    expect(isMarkedWorking(null, { fields: { Working: 'Yes' } })).toBe(false)
  })

  test('compara el campo declarado, case-insensitive en nombre y valor', () => {
    expect(isMarkedWorking(DEFAULT_WORKING_MARKER, { fields: { working: 'YES' } })).toBe(true)
    expect(isMarkedWorking(DEFAULT_WORKING_MARKER, { fields: { Working: 'No' } })).toBe(false)
    expect(isMarkedWorking(DEFAULT_WORKING_MARKER, { fields: {} })).toBe(false)
  })

  test('ignora el campo histórico si el proyecto declaró otro', () => {
    const marker = { field: 'Agente', on: 'corriendo', off: '' }
    expect(isMarkedWorking(marker, { fields: { Working: 'Yes' } })).toBe(false)
    expect(isMarkedWorking(marker, { fields: { Agente: 'corriendo' } })).toBe(true)
  })

  test('en un campo multi-valor mira las labels, sin el signo', () => {
    expect(isMarkedWorking(labelMarker, { labels: ['ia-flow:working', 'bug'] })).toBe(true)
    expect(isMarkedWorking(labelMarker, { labels: ['bug'] })).toBe(false)
    expect(isMarkedWorking(labelMarker, {})).toBe(false)
  })
})
