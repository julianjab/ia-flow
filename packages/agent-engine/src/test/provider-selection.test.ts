import { describe, expect, it } from 'bun:test'
import type { AgentProviderChoice, Task } from '@ia-flow/shared'
import {
  filterProviderCandidates,
  normalizeProviderChoices,
  resolveProvider,
} from '../provider-selection.js'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add login',
    description: 'desc',
    type: 'functional',
    repos: ['backend'],
    status: 'Build',
    created_at: '2026-01-01T00:00:00Z',
    projectId: 'proj-1',
    ...overrides,
  }
}

describe('normalizeProviderChoices', () => {
  it('un provider string plano se normaliza a un único choice sin when/whenText', () => {
    expect(normalizeProviderChoices('anthropic-api')).toEqual([{ providerId: 'anthropic-api' }])
  })

  it('un array de choices se devuelve tal cual', () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a' }, { providerId: 'b' }]
    expect(normalizeProviderChoices(choices)).toBe(choices)
  })
})

describe('filterProviderCandidates', () => {
  it('un choice sin when siempre pasa', () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a' }]
    expect(filterProviderCandidates(choices, task())).toEqual(choices)
  })

  it('filtra por when estructurado igual que evalWhen', () => {
    const choices: AgentProviderChoice[] = [
      { providerId: 'a', when: [{ field: 'type', op: '=', value: 'functional' }] },
      { providerId: 'b', when: [{ field: 'type', op: '=', value: 'technical' }] },
    ]
    expect(filterProviderCandidates(choices, task({ type: 'functional' }))).toEqual([choices[0]])
  })
})

describe('resolveProvider', () => {
  const neverCalled = async (): Promise<string | null> => {
    throw new Error('classify no debería llamarse')
  }

  it('provider string plano resuelve directo, sin llamar a classify (regresión: no rompe agentes existentes)', async () => {
    const result = await resolveProvider('anthropic-api', task(), neverCalled)
    expect(result).toBe('anthropic-api')
  })

  it('0 candidatos tras filtrar → null', async () => {
    const choices: AgentProviderChoice[] = [
      { providerId: 'a', when: [{ field: 'type', op: '=', value: 'technical' }] },
    ]
    const result = await resolveProvider(choices, task({ type: 'functional' }), neverCalled)
    expect(result).toBeNull()
  })

  it('1 candidato tras filtrar → ese, sin llamar a classify', async () => {
    const choices: AgentProviderChoice[] = [
      { providerId: 'a', when: [{ field: 'type', op: '=', value: 'functional' }] },
      { providerId: 'b', when: [{ field: 'type', op: '=', value: 'technical' }] },
    ]
    const result = await resolveProvider(choices, task({ type: 'functional' }), neverCalled)
    expect(result).toBe('a')
  })

  it('>1 candidatos, ninguno con whenText → el primero por orden del array, sin llamar a classify', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), neverCalled)
    expect(result).toBe('a')
  })

  it('>1 candidatos con whenText → llama a classify y devuelve lo que eligió', async () => {
    const choices: AgentProviderChoice[] = [
      { providerId: 'a', whenText: 'para tareas simples' },
      { providerId: 'b', whenText: 'para tareas complejas' },
    ]
    const result = await resolveProvider(choices, task(), async ({ candidates }) => {
      expect(candidates).toEqual([
        { providerId: 'a', whenText: 'para tareas simples' },
        { providerId: 'b', whenText: 'para tareas complejas' },
      ])
      return 'b'
    })
    expect(result).toBe('b')
  })

  it('classify devuelve null → null (falla el dispatch, no adivina)', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a', whenText: 'x' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), async () => null)
    expect(result).toBeNull()
  })

  it('classify devuelve un id fuera del set de candidatos → null', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a', whenText: 'x' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), async () => 'c')
    expect(result).toBeNull()
  })
})
