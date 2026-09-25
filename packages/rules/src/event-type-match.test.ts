import { describe, expect, test } from 'bun:test'
import { createEvent, type EngineEvent } from '@ia-flow/shared'
import { onMatchesEvent } from './event-type-match.js'

function ev(over: Partial<EngineEvent> = {}): EngineEvent {
  return createEvent({
    type: 'projects_v2_item',
    source: 'github',
    scope: {},
    payload: {},
    ...over,
  })
}

describe('onMatchesEvent', () => {
  test('literal: matchea el tipo exacto, sin action', () => {
    expect(onMatchesEvent(['pull_request'], ev({ type: 'pull_request' }))).toBe(true)
  })

  test('literal: un tipo sintético con punto propio matchea por igualdad, no se separa', () => {
    // `issue` no es un tipo real y `status_changed` no está en el payload —
    // si esto se separara en tipo+action, dejaría de matchear.
    expect(
      onMatchesEvent(['issue.status_changed'], ev({ type: 'issue.status_changed', payload: {} })),
    ).toBe(true)
  })

  test('wait.resumed/wait.expired matchean literal, no como tipo="wait" + action', () => {
    expect(onMatchesEvent(['wait.resumed'], ev({ type: 'wait.resumed', payload: {} }))).toBe(true)
  })

  test('tipo.action: separa y exige las dos condiciones', () => {
    const on = ['projects_v2_item.edited']
    expect(
      onMatchesEvent(on, ev({ type: 'projects_v2_item', payload: { action: 'edited' } })),
    ).toBe(true)
    expect(
      onMatchesEvent(on, ev({ type: 'projects_v2_item', payload: { action: 'created' } })),
    ).toBe(false)
    expect(onMatchesEvent(on, ev({ type: 'issues', payload: { action: 'edited' } }))).toBe(false)
  })

  test('mezcla: un entry con action y otros sin action en el mismo on[]', () => {
    const on = ['issue.created', 'issue.status_changed', 'projects_v2_item.edited']

    expect(onMatchesEvent(on, ev({ type: 'issue.created', payload: {} }))).toBe(true)
    expect(onMatchesEvent(on, ev({ type: 'issue.status_changed', payload: {} }))).toBe(true)
    expect(
      onMatchesEvent(on, ev({ type: 'projects_v2_item', payload: { action: 'edited' } })),
    ).toBe(true)
    // Otra action del mismo tipo crudo no matchea — sólo la declarada.
    expect(
      onMatchesEvent(on, ev({ type: 'projects_v2_item', payload: { action: 'created' } })),
    ).toBe(false)
  })

  test('sin action en el payload: tipo.action nunca matchea', () => {
    expect(
      onMatchesEvent(['projects_v2_item.edited'], ev({ type: 'projects_v2_item', payload: {} })),
    ).toBe(false)
  })

  test('un punto sin action después (mal escrito) no matchea nada', () => {
    expect(onMatchesEvent(['pull_request.'], ev({ type: 'pull_request', payload: {} }))).toBe(false)
  })
})
