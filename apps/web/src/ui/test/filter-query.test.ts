import { describe, expect, it } from 'vitest'
import {
  type FilterFieldDef,
  addToken,
  isDateValue,
  labelForToken,
  suggest,
  tokenFromDraft,
} from '../filter-query'

const fields: FilterFieldDef[] = [
  { key: 'agente', values: ['refiner', 'pr-reviewer', 'builder'] },
  { key: 'resultado', hint: 'cómo terminó', values: ['success', 'error'] },
  { key: 'tarea', hint: 'título o id' },
  { key: 'proveedor', values: ['anthropic-api', 'remote:mac'], free: true },
  // El id es opaco y nadie lo reconoce: se busca y se muestra por nombre.
  { key: 'proyecto', values: [{ value: 'PVT_kwDO', label: 'ia-flow' }] },
  { key: 'desde', free: true, validate: isDateValue },
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

describe('valores con etiqueta', () => {
  it('sugiere la etiqueta y guarda el valor', () => {
    const out = suggest('proyecto:ia', fields)
    expect(out).toEqual([{ kind: 'value', value: 'PVT_kwDO', label: 'ia-flow' }])
    expect(tokenFromDraft('proyecto:ia-flow', fields)).toEqual({
      field: 'proyecto',
      value: 'PVT_kwDO',
    })
  })

  // Quien conoce el id lo puede tipear igual, aunque en pantalla vea el nombre.
  it('también matchea por el valor', () => {
    expect(suggest('proyecto:PVT', fields).map((o) => o.label)).toEqual(['ia-flow'])
    expect(tokenFromDraft('proyecto:PVT_kwDO', fields)).toEqual({
      field: 'proyecto',
      value: 'PVT_kwDO',
    })
  })

  it('un token elegido se muestra por su etiqueta', () => {
    expect(labelForToken(fields, { field: 'proyecto', value: 'PVT_kwDO' })).toBe('ia-flow')
    // Sin etiqueta —o con un valor que ya no está— se muestra el valor.
    expect(labelForToken(fields, { field: 'agente', value: 'refiner' })).toBe('refiner')
    expect(labelForToken(fields, { field: 'proyecto', value: 'borrado' })).toBe('borrado')
  })
})

describe('addToken', () => {
  it('no duplica', () => {
    const tokens = [{ field: 'agente', value: 'refiner' }]
    expect(addToken(tokens, { field: 'agente', value: 'refiner' })).toBe(tokens)
    expect(addToken(tokens, { field: 'agente', value: 'builder' })).toHaveLength(2)
  })
})

// `desde:ayer` entraba como token y el `new Date(...)` de la consulta tiraba: el
// panel quedaba en "Invalid time value" sin nada que señalara a la fecha.
describe('campos libres con validación', () => {
  it('rechaza el token cuando el valor no pasa', () => {
    expect(tokenFromDraft('desde:ayer', fields)).toBeNull()
    expect(tokenFromDraft('desde:2025-13-01', fields)).toBeNull()
    expect(tokenFromDraft('desde:2025-02-31', fields)).toBeNull()
  })

  it('acepta fecha, y fecha con hora', () => {
    expect(tokenFromDraft('desde:2025-08-30', fields)).toEqual({
      field: 'desde',
      value: '2025-08-30',
    })
    expect(tokenFromDraft('desde:2025-08-30T14:05', fields)).toEqual({
      field: 'desde',
      value: '2025-08-30T14:05',
    })
  })

  it('un campo libre SIN validación sigue aceptando cualquier cosa', () => {
    expect(tokenFromDraft('tarea:lo que sea', fields)).toEqual({
      field: 'tarea',
      value: 'lo que sea',
    })
  })
})
