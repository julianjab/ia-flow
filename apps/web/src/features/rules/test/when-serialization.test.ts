import { rowsToWhen, whenToRows } from '@/features/rules/when-serialization'
import { describe, expect, it } from 'vitest'

describe('whenToRows', () => {
  it('convierte WhenCondition[] a filas, con logic "and" forzado en la primera', () => {
    const rows = whenToRows([
      { field: 'a', op: '=', value: '1' },
      { field: 'b', op: '!=', value: '2', logic: 'or' },
    ])
    expect(rows).toEqual([
      { field: 'a', op: '=', value: '1', logic: 'and' },
      { field: 'b', op: '!=', value: '2', logic: 'or' },
    ])
  })

  it('undefined/null/forma legacy Record → sin filas', () => {
    expect(whenToRows(undefined)).toEqual([])
    expect(whenToRows(null)).toEqual([])
    expect(whenToRows({ status: 'Refine' })).toEqual([])
  })
})

describe('rowsToWhen', () => {
  it('filtra filas sin field y trimea field/value', () => {
    const when = rowsToWhen([
      { field: '  a  ', op: '=', value: ' 1 ' },
      { field: '', op: '=', value: 'x' },
    ])
    expect(when).toEqual([{ field: 'a', op: '=', value: '1' }])
  })

  it('$null y $not_null no llevan value', () => {
    const when = rowsToWhen([{ field: 'a', op: '$null', value: 'lo que sea' }])
    expect(when).toEqual([{ field: 'a', op: '$null' }])
  })

  it('sin filas con field → undefined, no array vacío', () => {
    expect(rowsToWhen([])).toBeUndefined()
    expect(rowsToWhen([{ field: '', op: '=', value: '' }])).toBeUndefined()
  })

  it('round-trip con whenToRows preserva la forma', () => {
    const original = [
      { field: 'a', op: '=', value: '1' },
      { field: 'b', op: '$contains', value: 'x', logic: 'or' as const },
    ]
    expect(rowsToWhen(whenToRows(original))).toEqual(original)
  })
})
