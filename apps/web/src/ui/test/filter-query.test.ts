import { describe, expect, it } from 'vitest'
import { type FilterFieldDef, addToken, suggest, tokenFromDraft } from '../filter-query'

const fields: FilterFieldDef[] = [
  { key: 'agente', values: ['refiner', 'pr-reviewer', 'builder'] },
  { key: 'resultado', hint: 'cómo terminó', values: ['success', 'error'] },
  { key: 'tarea', hint: 'título o id' },
  { key: 'proveedor', values: ['anthropic-api', 'remote:mac'], free: true },
]

describe('suggest', () => {
  it('sin `:` ofrece campos', () => {
    expect(suggest('res', fields).map((o) => o.value)).toEqual(['resultado'])
    expect(suggest('res', fields)[0].kind).toBe('field')
  })

  it('con `:` ofrece los valores de ese campo', () => {
    const out = suggest('agente:', fields)
    expect(out.map((o) => o.value)).toEqual(['refiner', 'pr-reviewer', 'builder'])
    expect(out[0].kind).toBe('value')
  })

  // Escribir `re` busca lo que EMPIEZA con `re`, no lo que lo contiene en el
  // medio: es el orden en que uno lee una lista de sugerencias.
  it('lo que empieza con el término va antes de lo que lo contiene', () => {
    expect(suggest('agente:re', fields).map((o) => o.value)).toEqual(['refiner', 'pr-reviewer'])
  })

  it('no vuelve a ofrecer un valor ya elegido', () => {
    const out = suggest('agente:', fields, [{ field: 'agente', value: 'refiner' }])
    expect(out.map((o) => o.value)).toEqual(['pr-reviewer', 'builder'])
  })

  // Un menú vacío tapando lo que escribís es peor que ninguno.
  it('un campo de texto libre no ofrece nada', () => {
    expect(suggest('tarea:log', fields)).toEqual([])
  })

  it('un campo que no existe no ofrece nada', () => {
    expect(suggest('nada:x', fields)).toEqual([])
  })
})

describe('tokenFromDraft', () => {
  it('cierra el token y normaliza contra la lista', () => {
    expect(tokenFromDraft('resultado:ERROR', fields)).toEqual({
      field: 'resultado',
      value: 'error',
    })
  })

  // Filtrar por un valor que no existe devuelve vacío sin decir por qué.
  it('rechaza un valor fuera de una lista cerrada', () => {
    expect(tokenFromDraft('resultado:explotó', fields)).toBeNull()
  })

  it('acepta cualquier cosa en un campo libre', () => {
    expect(tokenFromDraft('tarea:login', fields)).toEqual({ field: 'tarea', value: 'login' })
    expect(tokenFromDraft('proveedor:otro', fields)).toEqual({
      field: 'proveedor',
      value: 'otro',
    })
  })

  // Un valor puede traer sus propios `:` — partir por el último los rompería.
  it('parte por el primer `:`', () => {
    expect(tokenFromDraft('proveedor:remote:mac', fields)).toEqual({
      field: 'proveedor',
      value: 'remote:mac',
    })
  })

  it('sin valor no hay token', () => {
    expect(tokenFromDraft('agente:', fields)).toBeNull()
    expect(tokenFromDraft('agente', fields)).toBeNull()
  })
})

describe('addToken', () => {
  it('no duplica', () => {
    const tokens = [{ field: 'agente', value: 'refiner' }]
    expect(addToken(tokens, { field: 'agente', value: 'refiner' })).toBe(tokens)
    expect(addToken(tokens, { field: 'agente', value: 'builder' })).toHaveLength(2)
  })
})
