import { describe, expect, test } from 'bun:test'
import { type EngineEvent, createEvent } from '@ia-flow/shared'
import { toRuleClassificationInput } from '../rule-classification.js'

const event = (payload: Record<string, unknown>): EngineEvent =>
  createEvent({ type: 'issue.scanned', source: 'engine', scope: {}, payload })

const rule = { id: 'r1', whenText: 'menciona autenticación' }

describe('toRuleClassificationInput', () => {
  test('mapea los campos del issue que el clasificador lee', () => {
    const input = toRuleClassificationInput(
      rule,
      event({ title: 'Login roto', description: 'no entra nadie', type: 'technical' }),
    )

    expect(input).toEqual({
      task: { title: 'Login roto', description: 'no entra nadie', type: 'technical' },
      agent: { id: 'r1', whenText: 'menciona autenticación' },
    })
  })

  // Un `ci.finished` o un `slack.message` no traen estos campos. El `whenText`
  // es un gate: hacerlo explotar dejaría sin correr un dispatch por una regla
  // que quizás ni matcheaba.
  test('un evento sin los campos del issue no explota', () => {
    const input = toRuleClassificationInput(rule, event({ conclusion: 'failure' }))

    expect(input.task).toEqual({ title: '', description: '', type: 'functional' })
  })

  // El payload es texto libre pero el clasificador tipa la unión cerrada.
  test('un type desconocido cae a functional, el default del sistema', () => {
    expect(toRuleClassificationInput(rule, event({ type: 'chirimoya' })).task.type).toBe(
      'functional',
    )
    expect(toRuleClassificationInput(rule, event({ type: 'technical' })).task.type).toBe(
      'technical',
    )
  })

  test('una regla sin whenText llega como string vacío, no como undefined', () => {
    expect(toRuleClassificationInput({ id: 'r2', whenText: undefined }, event({})).agent).toEqual({
      id: 'r2',
      whenText: '',
    })
  })
})
