import { describe, expect, it } from 'bun:test'
import { normalizeList } from './servers-store.js'

describe('normalizeList', () => {
  it('conserva la lista y su revisión', () => {
    expect(normalizeList({ rev: 42, servers: [{ baseUrl: 'http://a:3001' }] })).toEqual({
      rev: 42,
      servers: [{ baseUrl: 'http://a:3001' }],
    })
  })

  it('conserva label y token', () => {
    const raw = { rev: 1, servers: [{ baseUrl: 'http://a:3001', label: 'prod', token: 'sec' }] }
    expect(normalizeList(raw).servers[0]).toEqual({
      baseUrl: 'http://a:3001',
      label: 'prod',
      token: 'sec',
    })
  })

  // La regresión que motivó extraer este módulo: el renderer pasó a mandar
  // `{rev, servers}` y el handler seguía haciendo `Array.isArray(payload)`, así
  // que el primer guardado escribía `[]` sobre el único archivo con los tokens.
  it('NO descarta la lista cuando viene envuelta en un objeto', () => {
    const list = normalizeList({ rev: 7, servers: [{ baseUrl: 'http://a:3001' }] })
    expect(list.servers).toHaveLength(1)
  })

  // El formato viejo. Entra como la revisión más vieja posible para que la
  // primera escritura nueva le gane el desempate y lo reemplace.
  it('acepta un array pelado como rev 0', () => {
    expect(normalizeList([{ baseUrl: 'http://a:3001' }])).toEqual({
      rev: 0,
      servers: [{ baseUrl: 'http://a:3001' }],
    })
  })

  it('descarta las entradas sin baseUrl usable y conserva el resto', () => {
    const raw = {
      rev: 3,
      servers: [{ baseUrl: 'http://a:3001' }, { baseUrl: '   ' }, { label: 'sin url' }, null, 7],
    }
    expect(normalizeList(raw).servers).toEqual([{ baseUrl: 'http://a:3001' }])
  })

  it('recorta el baseUrl', () => {
    expect(
      normalizeList({ rev: 1, servers: [{ baseUrl: '  http://a:3001 ' }] }).servers[0],
    ).toEqual({ baseUrl: 'http://a:3001' })
  })

  it('ignora un rev que no sea un número positivo', () => {
    for (const rev of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, '9', null, undefined]) {
      expect(normalizeList({ rev, servers: [] }).rev).toBe(0)
    }
  })

  // Nunca tira: corre sobre un archivo editable a mano y sobre un mensaje de
  // IPC. Una excepción dejaría la app sin lista y sin forma de arreglarla.
  it('devuelve una lista vacía ante cualquier basura', () => {
    for (const raw of [null, undefined, 42, 'texto', {}, { servers: 'no' }]) {
      expect(normalizeList(raw)).toEqual({ rev: 0, servers: [] })
    }
  })
})
