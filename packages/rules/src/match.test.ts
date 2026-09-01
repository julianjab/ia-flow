import { describe, expect, test } from 'bun:test'
import { type EngineEvent, type Rule, createEvent } from '@ia-flow/shared'
import { matchRules, summarizeRuleRejections } from './match.js'

function rule(over: Partial<Rule> = {}): Rule {
  return {
    id: 'r1',
    on: ['pr.opened'],
    do: [{ action: 'agent', agentId: 'reviewer' }],
    ...over,
  }
}

function ev(over: Partial<EngineEvent> = {}): EngineEvent {
  return createEvent({
    type: 'pr.opened',
    source: 'github',
    scope: { projectId: 'p1', repos: ['api'] },
    payload: {},
    ...over,
  })
}

describe('matchRules — filtros', () => {
  test('el tipo de evento tiene que estar en on[]', () => {
    const { matched, rejected } = matchRules({
      event: ev({ type: 'ci.finished' }),
      rules: [rule()],
    })
    expect(matched).toHaveLength(0)
    expect(rejected[0]).toEqual({ id: 'r1', reason: 'type' })
  })

  test('una regla deshabilitada no dispara', () => {
    const { rejected } = matchRules({ event: ev(), rules: [rule({ enabled: false })] })
    expect(rejected[0].reason).toBe('disabled')
  })

  test('el ámbito acota por proyecto y por repo', () => {
    const inScope = rule({ id: 'ok', projectId: 'p1', repoName: 'api' })
    const otherProject = rule({ id: 'other-proj', projectId: 'p2' })
    const otherRepo = rule({ id: 'other-repo', projectId: 'p1', repoName: 'web' })

    const { matched, rejected } = matchRules({
      event: ev(),
      rules: [inScope, otherProject, otherRepo],
    })
    expect(matched.map((r) => r.id)).toEqual(['ok'])
    expect(rejected.every((r) => r.reason === 'scope')).toBe(true)
  })

  test('una regla global ve un evento sin scope; una de proyecto no', () => {
    // Fail-closed: es el caso de un mensaje suelto de Slack, que hasta que un
    // paso de triage le asigne proyecto sólo pueden verlo las reglas globales.
    const global = rule({ id: 'global', on: ['slack.message'] })
    const scoped = rule({ id: 'scoped', on: ['slack.message'], projectId: 'p1' })
    const raw = ev({ type: 'slack.message', scope: {} })

    const { matched } = matchRules({ event: raw, rules: [global, scoped] })
    expect(matched.map((r) => r.id)).toEqual(['global'])
  })

  test('las condiciones evalúan contra el payload, con caminos anidados', () => {
    const r = rule({ when: [{ field: 'pr.isDraft', op: '=', value: 'false' }] })
    const draft = ev({ payload: { pr: { isDraft: true } } })
    const ready = ev({ payload: { pr: { isDraft: false } } })

    expect(matchRules({ event: draft, rules: [r] }).matched).toHaveLength(0)
    expect(matchRules({ event: ready, rules: [r] }).matched).toHaveLength(1)
  })
})

describe('matchRules — orden y exclusividad', () => {
  test('TODAS las que matchean disparan, no sólo la primera', () => {
    // Es la diferencia semántica con selectAgent, y lo que permite que un PR
    // detone dos acciones.
    const { matched } = matchRules({
      event: ev(),
      rules: [rule({ id: 'a' }), rule({ id: 'b' })],
    })
    expect(matched.map((r) => r.id)).toEqual(['a', 'b'])
  })

  test('ordena por especificidad antes que por posición', () => {
    // Cada ámbito numera sus posiciones aparte, así que comparar posiciones
    // entre ámbitos no significa nada: sin este orden, reordenar las globales
    // las colaría delante de las de repo.
    const global = rule({ id: 'global', position: 0 })
    const project = rule({ id: 'project', projectId: 'p1', position: 9 })
    const repo = rule({ id: 'repo', projectId: 'p1', repoName: 'api', position: 5 })

    const { matched } = matchRules({ event: ev(), rules: [global, project, repo] })
    expect(matched.map((r) => r.id)).toEqual(['repo', 'project', 'global'])
  })

  test('position desempata dentro del mismo ámbito, e id cierra', () => {
    const { matched } = matchRules({
      event: ev(),
      rules: [
        rule({ id: 'z', projectId: 'p1', position: 1 }),
        rule({ id: 'a', projectId: 'p1', position: 1 }),
        rule({ id: 'first', projectId: 'p1', position: 0 }),
      ],
    })
    expect(matched.map((r) => r.id)).toEqual(['first', 'a', 'z'])
  })

  test('exclusive corta a las de MENOR prioridad, no a las ya matcheadas', () => {
    const repo = rule({ id: 'repo', projectId: 'p1', repoName: 'api', exclusive: true })
    const project = rule({ id: 'project', projectId: 'p1' })

    const { matched, rejected } = matchRules({ event: ev(), rules: [project, repo] })
    expect(matched.map((r) => r.id)).toEqual(['repo'])
    expect(rejected).toEqual([{ id: 'project', reason: 'exclusive' }])
  })
})

describe('summarizeRuleRejections', () => {
  test('agrupa por motivo en vez de listar ids sueltos', () => {
    expect(
      summarizeRuleRejections([
        { id: 'a', reason: 'type' },
        { id: 'b', reason: 'type' },
        { id: 'c', reason: 'scope' },
      ]),
    ).toBe('type: a, b | scope: c')
  })

  test('sin descartes lo dice', () => {
    expect(summarizeRuleRejections([])).toBe('sin candidatas')
  })
})
