import { describe, expect, it } from 'vitest'
import { hasTemplate, render, renderText, substituteVars } from '../template.js'

describe('render', () => {
  const root = { input: { comment: 'Sólo upgrades.' }, run: { exit: 'doubt' }, n: 3, list: ['a'] }

  it('a string that is only {{x}} returns the value as is', () => {
    expect(render('{{n}}', root)).toBe(3)
    expect(render('{{list}}', root)).toEqual(['a'])
    expect(render('{{nope}}', root)).toBeUndefined()
  })

  it('embedded in text it becomes text, empty when missing', () => {
    expect(render('dijo {{input.comment}} ({{run.exit}})', root)).toBe(
      'dijo Sólo upgrades. (doubt)',
    )
    expect(renderText('a{{nope}}b', root)).toBe('ab')
  })

  it('walks objects and lists, and does not resolve what it just inserted', () => {
    expect(render({ body: ['{{input.comment}}'] }, { input: { comment: '{{run.exit}}' } })).toEqual(
      {
        body: ['{{run.exit}}'],
      },
    )
  })
})

describe('hasTemplate / substituteVars', () => {
  it('detects a template anywhere in a document', () => {
    expect(hasTemplate({ a: [{ b: 'x {{y}}' }] })).toBe(true)
    expect(hasTemplate({ a: 'x' })).toBe(false)
  })

  it('substitutes only vars.* and fails loudly on an unknown one', () => {
    expect(substituteVars({ a: '{{vars.x}}', b: '{{run.exit}}' }, { x: 1 }, 'doc')).toEqual({
      a: 1,
      b: '{{run.exit}}',
    })
    expect(() => substituteVars({ a: '{{vars.zz}}' }, { x: 1 }, 'doc')).toThrow(
      /no hay una var "zz"/,
    )
  })
})
