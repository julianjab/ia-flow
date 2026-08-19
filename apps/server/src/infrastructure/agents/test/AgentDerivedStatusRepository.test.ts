import { describe, expect, it } from 'bun:test'
import type { AgentDefinition } from '@ia-flow/shared'
import type { IAgentRepository } from '../../../domain/ports/IAgentRepository.js'
import { AgentDerivedStatusRepository } from '../AgentDerivedStatusRepository.js'

function fakeAgentRepo(agents: AgentDefinition[]): IAgentRepository {
  return {
    inScope: () => agents,
    visibleTo: (projectId) =>
      agents.filter((a) => a.projectId == null || a.projectId === projectId),
    upsert: () => {},
    deleteById: () => {},
    clearScope: () => {},
    setPositions: () => {},
  }
}

const baseAgent: Omit<AgentDefinition, 'id'> = { provider: 'anthropic-api', prompt: 'x' }

describe('AgentDerivedStatusRepository', () => {
  it('deriva statuses únicos a partir de AgentDefinition.statusName', () => {
    const repo = new AgentDerivedStatusRepository(
      fakeAgentRepo([
        { id: 'a', ...baseAgent, projectId: 'p1', statusName: 'Refine' },
        { id: 'b', ...baseAgent, projectId: 'p1', statusName: 'Build' },
        // Mismo status que 'a' — no debe duplicarse.
        { id: 'c', ...baseAgent, projectId: 'p1', statusName: 'Refine' },
      ]),
    )

    expect(
      repo
        .list('p1')
        .map((s) => s.name)
        .sort(),
    ).toEqual(['Build', 'Refine'])
  })

  it('ignora agentes sin statusName (candidatos a cualquier status)', () => {
    const repo = new AgentDerivedStatusRepository(
      fakeAgentRepo([
        { id: 'a', ...baseAgent, projectId: 'p1', statusName: 'Refine' },
        { id: 'global', ...baseAgent, projectId: 'p1' },
      ]),
    )

    expect(repo.list('p1').map((s) => s.name)).toEqual(['Refine'])
  })

  it('getByName busca case-insensitive sobre la lista derivada', () => {
    const repo = new AgentDerivedStatusRepository(
      fakeAgentRepo([{ id: 'a', ...baseAgent, projectId: 'p1', statusName: 'Refine' }]),
    )

    expect(repo.getByName('p1', 'refine')?.name).toBe('Refine')
    expect(repo.getByName('p1', 'missing')).toBeNull()
  })

  it('los métodos de escritura tiran — es de solo lectura', () => {
    const repo = new AgentDerivedStatusRepository(fakeAgentRepo([]))

    expect(() => repo.upsert({ name: 'x' }, 0, 'p1')).toThrow(/solo lectura/)
    expect(() => repo.deleteByName('p1', 'x')).toThrow(/solo lectura/)
    expect(() => repo.clearScope('p1')).toThrow(/solo lectura/)
  })
})
