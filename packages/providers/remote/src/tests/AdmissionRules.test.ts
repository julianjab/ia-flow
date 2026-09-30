import { describe, expect, it } from 'vitest'
import { type AdmissionRule, evaluateAdmission } from '../AdmissionRules.js'
import { hintsFromQuery, hintsToQuery } from '../protocol.js'

const onlyEks: AdmissionRule = { field: 'repo', op: 'equals', value: 'la-haus/eks' }

describe('evaluateAdmission', () => {
  it('sin reglas acepta todo', () => {
    expect(evaluateAdmission([], { repo: ['x'] })).toEqual({ accept: true })
  })

  it('todas las reglas tienen que pasar', () => {
    const rules: AdmissionRule[] = [
      { field: 'repo', op: 'matches', value: 'la-haus/*' },
      { field: 'agentId', op: 'notEquals', value: 'reviewer' },
    ]
    expect(evaluateAdmission(rules, { repo: ['la-haus/eks'], agentId: ['implementer'] })).toEqual({
      accept: true,
    })
    expect(evaluateAdmission(rules, { repo: ['la-haus/eks'], agentId: ['reviewer'] })).toEqual({
      accept: false,
      reason: 'regla de admisión: agentId notEquals "reviewer"',
    })
    expect(evaluateAdmission(rules, { repo: ['otra/eks'] }).accept).toBe(false)
  })

  it('una pista que no vino no rechaza; una que vino vacía, sí', () => {
    expect(evaluateAdmission([onlyEks], { agentId: ['a'] }).accept).toBe(true)
    expect(evaluateAdmission([onlyEks], { repo: [] }).accept).toBe(false)
  })

  it('"vino vacía" sobrevive la query de la sonda', () => {
    const hints = hintsFromQuery(hintsToQuery({ repo: [], agentId: ['a'] }))
    expect(hints).toEqual({ repo: [], agentId: ['a'] })
  })
})
