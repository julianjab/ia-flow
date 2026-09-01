import { describe, expect, it } from 'bun:test'
import type { Project } from '@ia-flow/shared'
import type { Rule } from '@ia-flow/shared'
import type { IProjectRepository } from '../../../domain/ports/IProjectRepository.js'
import type { IRuleRepository } from '../../../domain/ports/IRuleRepository.js'
import { ProjectScopedRuleRepository } from '../ProjectScopedRuleRepository.js'

const rule = (id: string, projectId: string | null = null): Rule =>
  ({ id, on: ['issue.scanned'], do: [], projectId }) as unknown as Rule

function repos(rules: Rule[], settings?: Record<string, unknown>) {
  const listed: Rule[] = []
  const inner = {
    isReadOnly: () => false,
    visibleTo: async () => rules,
    list: async () => {
      listed.push(...rules)
      return rules
    },
    getById: async (id: string) => rules.find((r) => r.id === id) ?? null,
    upsert: async (r: Rule) => r,
    deleteById: async () => true,
    setPositions: async () => {},
  } satisfies IRuleRepository

  const projects = {
    get: () => ({ id: 'p1', name: 'P1', settings }) as unknown as Project,
  } as unknown as IProjectRepository

  return { repo: new ProjectScopedRuleRepository(inner, projects), listed }
}

describe('ProjectScopedRuleRepository', () => {
  it('saca del visibleTo las globales que el proyecto dio de baja', async () => {
    const { repo } = repos([rule('a'), rule('b')], { disabledRuleIds: ['b'] })

    const visible = await repo.visibleTo('p1')

    expect(visible.map((r) => r.id)).toEqual(['a'])
  })

  it('no toca las reglas PROPIAS del proyecto', async () => {
    // Una propia se apaga con su `enabled`. Si el id coincidiera con el de una
    // global dada de baja, apagar la global se llevaría puesta la propia.
    const { repo } = repos([rule('a', 'p1')], { disabledRuleIds: ['a'] })

    expect((await repo.visibleTo('p1')).map((r) => r.id)).toEqual(['a'])
  })

  it('sin projectId no filtra — un evento sin scope sólo ve globales', async () => {
    const { repo } = repos([rule('a')], { disabledRuleIds: ['a'] })

    expect((await repo.visibleTo()).map((r) => r.id)).toEqual(['a'])
  })

  it('`list` NO se filtra: es el CRUD, y una dada de baja tiene que poder volver', async () => {
    // El punto entero del toggle. Si `list` filtrara, apagar una regla la haría
    // desaparecer de la pantalla y no habría dónde volver a prenderla.
    const { repo } = repos([rule('a'), rule('b')], { disabledRuleIds: ['a', 'b'] })

    expect((await repo.list({ global: true })).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('un proyecto sin bajas devuelve lo mismo que el repo de abajo', async () => {
    const { repo } = repos([rule('a')], {})

    expect((await repo.visibleTo('p1')).map((r) => r.id)).toEqual(['a'])
  })

  it('delega el resto del port sin opinar', async () => {
    const { repo } = repos([rule('a')])

    expect(repo.isReadOnly()).toBe(false)
    expect((await repo.getById('a'))?.id).toBe('a')
    expect(await repo.deleteById('a')).toBe(true)
  })
})
