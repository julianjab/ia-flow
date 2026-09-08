import type { TaskGroups } from '@ia-flow/shared'
import { describe, expect, test } from 'vitest'
import { sectionRows } from '../task-grouping'

interface Row {
  id: string
}

function rows(ids: string[]): Row[] {
  return ids.map((id) => ({ id }))
}

function groups(entries: Array<{ label: string; taskIds: string[] }>): TaskGroups {
  return { groups: entries, computedAt: '2026-09-08T00:00:00.000Z' }
}

describe('sectionRows', () => {
  test('sin grupos, todo cae en una sola sección suelta', () => {
    expect(sectionRows(rows(['t1', 't2']), null)).toEqual([
      { kind: 'loose', rows: rows(['t1', 't2']) },
    ])
  })

  test('lista vacía no produce secciones', () => {
    expect(sectionRows([], null)).toEqual([])
  })

  test('un grupo se dibuja en la posición de su primer integrante, con el resto adentro', () => {
    const out = sectionRows(
      rows(['t1', 't2', 't3', 't4']),
      groups([{ label: 'auth', taskIds: ['t2', 't4'] }]),
    )
    expect(out).toEqual([
      { kind: 'loose', rows: rows(['t1']) },
      { kind: 'group', label: 'auth', rows: rows(['t2', 't4']) },
      { kind: 'loose', rows: rows(['t3']) },
    ])
  })

  test('lo suelto entre dos grupos se agrupa en su propia sección', () => {
    const out = sectionRows(
      rows(['t1', 't2', 't3', 't4', 't5']),
      groups([
        { label: 'a', taskIds: ['t1'] },
        { label: 'b', taskIds: ['t4', 't5'] },
      ]),
    )
    // 't1' solo no forma parte de ningún grupo real (min 2 ya lo filtra el
    // server, pero si llegara así de todos modos no rompe: sigue siendo un id
    // sin grupo si no hay otro con la misma label).
    expect(out).toEqual([
      { kind: 'group', label: 'a', rows: rows(['t1']) },
      { kind: 'loose', rows: rows(['t2', 't3']) },
      { kind: 'group', label: 'b', rows: rows(['t4', 't5']) },
    ])
  })

  test('respeta el orden relativo de las filas ya congelado, no el del grupo', () => {
    const out = sectionRows(
      rows(['t3', 't1', 't2']),
      groups([{ label: 'x', taskIds: ['t1', 't2', 't3'] }]),
    )
    expect(out).toEqual([{ kind: 'group', label: 'x', rows: rows(['t3', 't1', 't2']) }])
  })

  test('un id sin fila (el server lo devolvió pero ya no está en la lista) no rompe nada', () => {
    const out = sectionRows(
      rows(['t1', 't2']),
      groups([{ label: 'x', taskIds: ['t1', 't2', 'fantasma'] }]),
    )
    expect(out).toEqual([{ kind: 'group', label: 'x', rows: rows(['t1', 't2']) }])
  })
})
