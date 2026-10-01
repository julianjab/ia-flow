import { describe, expect, it } from 'vitest'
import { describeError, flattenError } from '../errors.js'
import { errorAttributes } from '../tracing.js'

describe('flattenError', () => {
  it('aplana un AggregateError con sus causas y la ruta de cada una', () => {
    const inner = new Error('boom', { cause: new TypeError('raíz') })
    const err = new AggregateError([inner, 'texto'], '2 pipeline(s) failed')
    const details = flattenError(err)
    expect(details.map((d) => [d.path, d.type, d.message])).toEqual([
      ['', 'AggregateError', '2 pipeline(s) failed'],
      ['errors[0]', 'Error', 'boom'],
      ['errors[0].cause', 'TypeError', 'raíz'],
      ['errors[1]', 'string', 'texto'],
    ])
  })

  it('corta un ciclo de causes', () => {
    const a = new Error('a')
    a.cause = a
    expect(flattenError(a).length).toBeLessThanOrEqual(9)
  })
})

describe('describeError / errorAttributes', () => {
  it('un error simple es su mensaje', () => {
    expect(describeError(new Error('x'))).toBe('x')
  })

  it('incluye la causa de cada pipeline', () => {
    const err = new AggregateError([new Error('sin token')], '1 pipeline(s) failed')
    expect(describeError(err)).toBe('1 pipeline(s) failed [errors[0]: Error: sin token]')
    const attrs = errorAttributes(err)
    expect(attrs['exception.type']).toBe('AggregateError')
    expect(attrs['exception.causes.count']).toBe(1)
    expect(String(attrs['exception.causes'])).toContain('sin token')
  })
})
