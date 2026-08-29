import { describe, expect, test } from 'bun:test'
import { ISSUE_CREATED, ISSUE_STATUS_CHANGED, diffStatus } from './status-diff.js'

const item = { id: 'i1', status: 'Ready', repos: ['api'], projectId: 'p1' }

describe('diffStatus', () => {
  test('un item que no se movió no produce evento', () => {
    // El caso normal y por lejos el más frecuente: en cada tick la enorme
    // mayoría del board sigue igual. Ése es todo el punto — hoy cada scan
    // reprocesa el board entero.
    expect(diffStatus({ item, before: 'Ready', bootstrap: false })).toBeNull()
  })

  test('un cambio de status produce el hecho, con de dónde vino', () => {
    const e = diffStatus({ item, before: 'Backlog', bootstrap: false })
    expect(e?.type).toBe(ISSUE_STATUS_CHANGED)
    expect(e?.payload).toMatchObject({ from: 'Backlog', to: 'Ready' })
  })

  test('`status` viaja con el valor NUEVO', () => {
    // Para que una condición escrita contra `issue.scanned` siga significando
    // lo mismo cuando se la aplica a este evento.
    const e = diffStatus({ item, before: 'Backlog', bootstrap: false })
    expect((e?.payload as { status: string }).status).toBe('Ready')
  })

  test('un item nunca visto es issue.created', () => {
    const e = diffStatus({ item, before: undefined, bootstrap: false })
    expect(e?.type).toBe(ISSUE_CREATED)
  })

  test('el primer scan del proyecto NO emite nada — sólo aprende', () => {
    // Sin esto, un board de 200 issues emitiría 200 `issue.created` al
    // bootear, y las reglas dispararían sobre issues viejos que nadie tocó.
    expect(diffStatus({ item, before: undefined, bootstrap: true })).toBeNull()
    expect(diffStatus({ item, before: 'Backlog', bootstrap: true })).toBeNull()
  })

  test('un cambio sólo de mayúsculas no es un movimiento', () => {
    // Los boards de GitHub no garantizan capitalización estable.
    expect(diffStatus({ item, before: 'ready', bootstrap: false })).toBeNull()
  })

  test('el scope lleva proyecto, repos e issue', () => {
    const e = diffStatus({ item, before: 'Backlog', bootstrap: false })
    expect(e?.scope).toEqual({ projectId: 'p1', repos: ['api'], issueId: 'i1' })
  })
})
