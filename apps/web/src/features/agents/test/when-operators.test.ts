import {
  type AgentCondition,
  type ConditionOp,
  entryToWhen,
  opTakesValue,
  whenToConditions,
} from '@/features/agents/outcomes-serialization'
import { describe, expect, it } from 'vitest'

// Los operadores nuevos (`>`, `>=`, `<`, `<=`, `$contains`, `$matches`) tienen
// que sobrevivir el round-trip editor ↔ wire igual que `=` y `!=`. El
// evaluador que los consume vive en `@ia-flow/rules`; acá se cubre sólo la
// serialización del front.

function cond(op: ConditionOp, value = ''): AgentCondition {
  return { field: 'additions', op, value, logic: 'and' }
}

describe('opTakesValue', () => {
  it('los ops unarios no llevan valor', () => {
    expect(opTakesValue('$null')).toBe(false)
    expect(opTakesValue('$not_null')).toBe(false)
  })

  it('todos los demás sí', () => {
    for (const op of ['=', '!=', '>', '>=', '<', '<=', '$contains', '$matches'] as ConditionOp[]) {
      expect(opTakesValue(op)).toBe(true)
    }
  })
})

describe('entryToWhen', () => {
  it('conserva el valor de los operadores nuevos', () => {
    expect(entryToWhen([cond('>', '500')])).toEqual([{ field: 'additions', op: '>', value: '500' }])
    expect(entryToWhen([cond('$matches', '^feat/')])).toEqual([
      { field: 'additions', op: '$matches', value: '^feat/' },
    ])
  })

  it('sigue omitiendo el valor en los unarios', () => {
    expect(entryToWhen([cond('$null', 'basura')])).toEqual([{ field: 'additions', op: '$null' }])
  })
})

describe('whenToConditions — formato Record legacy', () => {
  it('decodifica cada prefijo a su operador', () => {
    expect(whenToConditions({ additions: '$gt:500' })[0]).toMatchObject({
      op: '>',
      value: '500',
    })
    expect(whenToConditions({ additions: '$lte:10' })[0]).toMatchObject({ op: '<=', value: '10' })
    expect(whenToConditions({ title: '$contains:login' })[0]).toMatchObject({
      op: '$contains',
      value: 'login',
    })
    expect(whenToConditions({ branch: '$matches:^feat/' })[0]).toMatchObject({
      op: '$matches',
      value: '^feat/',
    })
  })

  it('$gte no se confunde con $gt, que es su prefijo', () => {
    expect(whenToConditions({ additions: '$gte:500' })[0]).toMatchObject({ op: '>=', value: '500' })
  })

  it('un valor pelado sigue siendo igualdad', () => {
    expect(whenToConditions({ status: 'Ready' })[0]).toMatchObject({ op: '=', value: 'Ready' })
  })

  it('los unarios se decodifican sin valor', () => {
    expect(whenToConditions({ repos: '$null' })[0]).toMatchObject({ op: '$null', value: '' })
  })
})

describe('round-trip', () => {
  it('editor → wire → editor conserva op y valor', () => {
    const conditions: AgentCondition[] = [
      cond('>=', '500'),
      { field: 'title', op: '$contains', value: 'login', logic: 'or' },
    ]
    expect(whenToConditions(entryToWhen(conditions))).toEqual(conditions)
  })
})
