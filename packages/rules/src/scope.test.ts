import { describe, expect, test } from 'bun:test'
import { matchScope } from './scope.js'

describe('matchScope', () => {
  test('una ubicación vacía es global: matchea cualquier sujeto', () => {
    expect(matchScope({}, { projectId: 'p1', repos: ['api'] })).toBe(true)
    expect(matchScope({ projectId: null, repoName: null }, { projectId: 'p2' })).toBe(true)
    expect(matchScope({}, {})).toBe(true)
  })

  test('projectId acota al proyecto y nada más', () => {
    expect(matchScope({ projectId: 'p1' }, { projectId: 'p1', repos: ['api'] })).toBe(true)
    expect(matchScope({ projectId: 'p1' }, { projectId: 'p2', repos: ['api'] })).toBe(false)
  })

  test('repoName es pertenencia contra la lista, no igualdad', () => {
    expect(matchScope({ repoName: 'api' }, { repos: ['web', 'api'] })).toBe(true)
    expect(matchScope({ repoName: 'api' }, { repos: ['web'] })).toBe(false)
  })

  test('una ubicación con repo exige proyecto Y repo, no uno de los dos', () => {
    const location = { projectId: 'p1', repoName: 'api' }
    expect(matchScope(location, { projectId: 'p1', repos: ['api'] })).toBe(true)
    expect(matchScope(location, { projectId: 'p2', repos: ['api'] })).toBe(false)
    expect(matchScope(location, { projectId: 'p1', repos: ['web'] })).toBe(false)
  })

  test('un sujeto sin repos sólo lo matchean ubicaciones sin repo', () => {
    // Una task sin refinar (`repos: []`) tiene que poder ser tomada por el
    // refinador global, y no por el implementador de un repo puntual.
    expect(matchScope({ projectId: 'p1' }, { projectId: 'p1', repos: [] })).toBe(true)
    expect(matchScope({ projectId: 'p1', repoName: 'api' }, { projectId: 'p1', repos: [] })).toBe(
      false,
    )
    expect(matchScope({ repoName: 'api' }, { projectId: 'p1' })).toBe(false)
  })

  test('fail-closed: un sujeto sin scope no lo ve una ubicación que sí lo declara', () => {
    // Es el caso de un mensaje suelto de Slack: hasta que un paso de triage le
    // asigne proyecto, sólo las reglas globales pueden verlo. Lo contrario
    // dispararía las reglas de todos los proyectos a la vez.
    expect(matchScope({ projectId: 'p1' }, {})).toBe(false)
    expect(matchScope({}, {})).toBe(true)
  })
})
