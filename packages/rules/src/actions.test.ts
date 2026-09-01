import { afterEach, describe, expect, test } from 'bun:test'
import type { RuleActionEntry } from '@ia-flow/shared'
import { z } from 'zod'
import { clearActionRegistry, registerAction, validateActions } from './actions.js'

// El gate de GUARDADO: una regla que despacha a ciegas no debería poder existir
// en la base. Descubrirlo en el primer disparo es el modo de falla silencioso
// que este sistema tiene que dejar de tener.

function registerAgent() {
  registerAction({
    kind: 'agent',
    configSchema: z
      .object({ action: z.literal('agent'), agentId: z.string().min(1) })
      .passthrough(),
    execute: async () => ({ ok: true }),
  })
}

afterEach(clearActionRegistry)

describe('validateActions — agentId dinámico', () => {
  const entries = (e: Record<string, unknown>) => [e] as unknown as RuleActionEntry[]

  test('un agentId de un paso anterior SIN allowAgents no se puede guardar', () => {
    registerAgent()
    const errs = validateActions(
      entries({ action: 'agent', agentId: '{{steps.triage.output.next}}' }),
    )
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toContain('allowAgents')
  })

  test('con allowAgents sí', () => {
    registerAgent()
    const errs = validateActions(
      entries({
        action: 'agent',
        agentId: '{{steps.triage.output.next}}',
        allowAgents: ['implementer'],
      }),
    )
    expect(errs).toEqual([])
  })

  test('una lista vacía no cuenta como declarada', () => {
    registerAgent()
    const errs = validateActions(
      entries({ action: 'agent', agentId: '{{steps.x.output}}', allowAgents: [] }),
    )
    expect(errs).toHaveLength(1)
  })

  // La lista tiene que ser una decisión del operador tomada por adelantado. Si
  // sale de un paso, la escribe el mismo modelo que después elige adentro.
  test('una lista que sale de un paso no cuenta como declarada', () => {
    registerAgent()
    const errs = validateActions(
      entries({
        action: 'agent',
        agentId: '{{steps.t.output.next}}',
        allowAgents: ['{{steps.t.output.next}}'],
      }),
    )
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toContain('allowAgents')
  })

  test('un agentId literal no necesita nada', () => {
    registerAgent()
    expect(validateActions(entries({ action: 'agent', agentId: 'implementer' }))).toEqual([])
  })

  // El chequeo corre DESPUÉS del schema: sin agentId el error es del schema, y
  // sumarle uno sobre allowAgents sería ruido sobre una config a medio escribir.
  test('no se apila sobre un error de schema', () => {
    registerAgent()
    const errs = validateActions(entries({ action: 'agent' }))
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toContain('agentId')
  })
})
