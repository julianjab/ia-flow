import { describe, expect, it } from 'bun:test'
import type { EngineEvent } from '@ia-flow/shared'
import { renderBrief } from './brief.js'

function event(overrides: Partial<EngineEvent> = {}): EngineEvent {
  return {
    id: 'evt-1',
    type: 'pr.opened',
    at: '2026-09-01T00:00:00.000Z',
    scope: { projectId: 'p1' },
    payload: {},
    depth: 0,
    ...overrides,
  } as EngineEvent
}

describe('renderBrief', () => {
  it('resuelve los campos del evento y los caminos anidados del payload', () => {
    const out = renderBrief(
      'Se abrió el PR #{{event.payload.pr.number}} ({{event.type}}) en {{event.scope.projectId}}.',
      event({ payload: { pr: { number: 482 } } }),
    )
    expect(out).toBe('Se abrió el PR #482 (pr.opened) en p1.')
  })

  it('tolera espacios adentro de las llaves', () => {
    expect(renderBrief('{{ event.type }}', event())).toBe('pr.opened')
  })

  // Un brief con un typo tiene que ser legible EN el prompt como el typo que
  // es. Reemplazarlo por vacío deja al agente con una instrucción trunca y sin
  // ninguna pista de por qué.
  it('deja literal una ruta que no existe, en vez de vaciarla', () => {
    expect(renderBrief('n={{event.payload.nope.deep}}', event())).toBe(
      'n={{event.payload.nope.deep}}',
    )
  })

  it('deja literal un camino que atraviesa un valor no-objeto', () => {
    expect(renderBrief('{{event.type.number}}', event())).toBe('{{event.type.number}}')
  })

  // Apuntar un nivel más arriba del que se quería es el error más común; que
  // salga el JSON en vez de `[object Object]` es lo que lo hace diagnosticable.
  it('serializa objetos y arrays como JSON', () => {
    const out = renderBrief('{{event.payload.pr}}', event({ payload: { pr: { number: 7 } } }))
    expect(out).toBe('{"number":7}')
  })

  it('serializa números y booleanos sin comillas', () => {
    const out = renderBrief(
      '{{event.payload.n}}/{{event.payload.b}}',
      event({ payload: { n: 0, b: false } }),
    )
    expect(out).toBe('0/false')
  })

  it('no toca las variables del agente — sólo las de event', () => {
    expect(renderBrief('{{task.title}} y {{event.type}}', event())).toBe(
      '{{task.title}} y pr.opened',
    )
  })

  it('sobrevive a un payload con un ciclo', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const out = renderBrief('{{event.payload.item}}', event({ payload: { item: cyclic } }))
    expect(out).toContain('object')
  })
})
