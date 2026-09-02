import { beforeEach, describe, expect, test } from 'bun:test'
import type { RuleClassificationInput } from '../rule-classification.js'
import {
  cachedVerdict,
  clearRuleWhenTextVerdicts,
  rememberVerdict,
} from '../rule-whentext-cache.js'

const input = (over: Partial<RuleClassificationInput> = {}): RuleClassificationInput => ({
  task: { title: 'Login roto', description: 'no entra nadie', type: 'technical' },
  agent: { id: 'r1', whenText: 'menciona autenticación' },
  ...over,
})

beforeEach(() => {
  clearRuleWhenTextVerdicts()
})

describe('rule-whentext-cache', () => {
  test('sin veredicto guardado, undefined', () => {
    expect(cachedVerdict('r1', input())).toBeUndefined()
  })

  test('guarda y devuelve el mismo veredicto para el mismo input', () => {
    rememberVerdict('r1', input(), true)
    expect(cachedVerdict('r1', input())).toBe(true)
  })

  test('un veredicto false también se cachea — no sólo el true', () => {
    rememberVerdict('r1', input(), false)
    expect(cachedVerdict('r1', input())).toBe(false)
  })

  test('distinta regla, distinta key — no colapsan', () => {
    rememberVerdict('r1', input(), true)
    expect(cachedVerdict('r2', input())).toBeUndefined()
  })

  test('un título distinto invalida el cache — nunca se reescribió la key vieja', () => {
    rememberVerdict(
      'r1',
      input({ task: { title: 'A', description: '', type: 'functional' } }),
      true,
    )
    expect(
      cachedVerdict('r1', input({ task: { title: 'B', description: '', type: 'functional' } })),
    ).toBeUndefined()
  })

  test('una conversación nueva invalida el veredicto — el gate se vuelve a preguntar', () => {
    rememberVerdict('r1', input({ conversation: 'viejo' }), false)
    expect(cachedVerdict('r1', input({ conversation: 'nuevo' }))).toBeUndefined()
  })

  test('sin conversación vs con conversación son keys distintas', () => {
    rememberVerdict('r1', input(), true)
    expect(cachedVerdict('r1', input({ conversation: 'algo' }))).toBeUndefined()
  })
})
