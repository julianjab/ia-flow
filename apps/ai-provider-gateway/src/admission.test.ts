import { describe, expect, it } from 'bun:test'
import { type AdmissionRule, evaluateAdmission, isAdmissionRule } from './admission.js'

const rule = (r: AdmissionRule) => [r]

describe('evaluateAdmission', () => {
  it('sin reglas acepta todo — es como se comportaba antes de que esto existiera', () => {
    expect(evaluateAdmission([], { repos: ['x'] }).accepting).toBe(true)
  })

  it('repo matchea contra CUALQUIERA de los repos de la tarea', () => {
    const rules = rule({ field: 'repo', op: 'equals', value: 'la-haus/subscriptions' })
    expect(evaluateAdmission(rules, { repos: ['otro', 'la-haus/subscriptions'] }).accepting).toBe(
      true,
    )
    expect(evaluateAdmission(rules, { repos: ['otro'] }).accepting).toBe(false)
  })

  it('notEquals rechaza sólo si está', () => {
    const rules = rule({ field: 'agentId', op: 'notEquals', value: 'e2e' })
    expect(evaluateAdmission(rules, { agentId: 'e2e' }).accepting).toBe(false)
    expect(evaluateAdmission(rules, { agentId: 'builder' }).accepting).toBe(true)
  })

  it('matches usa * como comodín, y no como regex', () => {
    const rules = rule({ field: 'agentId', op: 'matches', value: 'lh116-*' })
    expect(evaluateAdmission(rules, { agentId: 'lh116-e2e-tester' }).accepting).toBe(true)
    expect(evaluateAdmission(rules, { agentId: 'otro-lh116-x' }).accepting).toBe(false)
    // El punto es literal: sin escapar, "a.c" matchearía "abc".
    const dotted = rule({ field: 'agentId', op: 'matches', value: 'a.c' })
    expect(evaluateAdmission(dotted, { agentId: 'abc' }).accepting).toBe(false)
  })

  it('un campo que la tarea no trae NO rechaza — la sonda no tiene cuerpo', () => {
    const rules = rule({ field: 'repo', op: 'equals', value: 'x' })
    expect(evaluateAdmission(rules, {}).accepting).toBe(true)
  })

  it('todas las reglas tienen que pasar, y el motivo nombra la que falló', () => {
    const verdict = evaluateAdmission(
      [
        { field: 'repo', op: 'equals', value: 'ok' },
        { field: 'agentId', op: 'notEquals', value: 'malo' },
      ],
      { repos: ['ok'], agentId: 'malo' },
    )
    expect(verdict.accepting).toBe(false)
    expect(verdict.reason).toContain('agentId')
  })
})

describe('isAdmissionRule', () => {
  it('rechaza campos y ops desconocidos, y valores vacíos', () => {
    expect(isAdmissionRule({ field: 'repo', op: 'equals', value: 'x' })).toBe(true)
    expect(isAdmissionRule({ field: 'inventado', op: 'equals', value: 'x' })).toBe(false)
    expect(isAdmissionRule({ field: 'repo', op: 'regex', value: 'x' })).toBe(false)
    expect(isAdmissionRule({ field: 'repo', op: 'equals', value: '' })).toBe(false)
    expect(isAdmissionRule(null)).toBe(false)
  })
})
