import { describe, expect, it } from 'bun:test'
import { applyMultiValueOps, isMultiValueField } from '../dispatch/field-ops.js'

describe('applyMultiValueOps', () => {
  it('añade conservando lo que ya estaba', () => {
    expect(applyMultiValueOps(['bug'], '+urgent')).toEqual(['bug', 'urgent'])
  })

  it('quita sin tocar el resto', () => {
    expect(applyMultiValueOps(['bug', 'ci-checked'], '-ci-checked')).toEqual(['bug'])
  })

  it('reemplaza el set completo con =', () => {
    expect(applyMultiValueOps(['bug', 'stale'], '=listo')).toEqual(['listo'])
  })

  it('mezcla añadir y quitar en un mismo spec', () => {
    expect(applyMultiValueOps(['a', 'b'], '+c,-a')).toEqual(['b', 'c'])
  })

  it('quitar gana sobre añadir para el mismo valor', () => {
    expect(applyMultiValueOps(['a'], '+dup,-dup')).toEqual(['a'])
  })

  it('un = define la base y los + se aplican encima', () => {
    expect(applyMultiValueOps(['viejo'], '=base,+extra')).toEqual(['base', 'extra'])
  })

  it('no duplica un valor que ya estaba', () => {
    expect(applyMultiValueOps(['bug'], '+bug')).toEqual(['bug'])
  })

  it('un token sin signo se interpreta como añadir', () => {
    expect(applyMultiValueOps([], 'suelta')).toEqual(['suelta'])
  })

  it('tolera espacios y tokens vacíos', () => {
    expect(applyMultiValueOps([], ' +a , , -b ,')).toEqual(['a'])
  })

  it('un = pelado vacía el campo', () => {
    // Distinto de "no traer ningún =": es la única forma de expresar "vaciar".
    expect(applyMultiValueOps(['a', 'b'], '=')).toEqual([])
  })

  it('un spec vacío deja el valor intacto', () => {
    expect(applyMultiValueOps(['a'], '')).toEqual(['a'])
  })
})

describe('isMultiValueField', () => {
  it('reconoce el campo sin importar capitalización ni espacios', () => {
    expect(isMultiValueField('Labels')).toBe(true)
    expect(isMultiValueField(' labels ')).toBe(true)
  })

  it('no confunde otros campos', () => {
    expect(isMultiValueField('Status')).toBe(false)
    expect(isMultiValueField('Assignees')).toBe(false)
  })
})
