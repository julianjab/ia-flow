import { describe, expect, it } from 'bun:test'
import type { AdmissionRequest } from '@ia-flow/ai-providers'
import type { AgentProviderChoice, Task } from '@ia-flow/shared'
import type { PendingTask } from '../pending-tasks.js'
import {
  expandProviderWildcards,
  filterProviderCandidates,
  normalizeProviderChoices,
  resolveProvider,
} from '../provider-selection.js'

/** Snapshot de pending tasks con N runs en vuelo por provider. */
function running(counts: Record<string, number>): () => Array<[string, PendingTask]> {
  const entries: Array<[string, PendingTask]> = []
  for (const [providerId, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      entries.push([`${providerId}-${i}`, { providerId } as PendingTask])
    }
  }
  return () => entries
}

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

describe('expandProviderWildcards', () => {
  const REGISTERED = ['anthropic-api', 'remote:julianbuitrago-mac', 'remote:otra-mac']

  it('remote:* expande a todos los remotos registrados, heredando su config', () => {
    const out = expandProviderWildcards(
      [{ providerId: 'remote:*', whenText: 'runs pesados' }],
      REGISTERED,
    )
    expect(out.map((c) => c.providerId)).toEqual(['remote:julianbuitrago-mac', 'remote:otra-mac'])
    expect(out.every((c) => c.whenText === 'runs pesados')).toBe(true)
  })

  it('un id explícito no se duplica y conserva su posición y su config', () => {
    const out = expandProviderWildcards(
      [
        { providerId: 'remote:julianbuitrago-mac', whenText: 'preferida' },
        { providerId: 'remote:*' },
      ],
      REGISTERED,
    )
    expect(out.map((c) => c.providerId)).toEqual(['remote:julianbuitrago-mac', 'remote:otra-mac'])
    expect(out[0]?.whenText).toBe('preferida')
  })

  it('comodín sin registrados expande a nada — el siguiente candidato es el fallback', () => {
    const out = expandProviderWildcards(
      [{ providerId: 'remote:*' }, { providerId: 'anthropic-api' }],
      ['anthropic-api'],
    )
    expect(out.map((c) => c.providerId)).toEqual(['anthropic-api'])
  })

  it('sin comodines devuelve los candidatos tal cual', () => {
    const choices = [{ providerId: 'anthropic-api' }]
    expect(expandProviderWildcards(choices, REGISTERED)).toEqual(choices)
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
    expect(result).toEqual({ kind: 'resolved', providerId: 'anthropic-api' })
  })

  it('0 candidatos tras filtrar → none', async () => {
    const choices: AgentProviderChoice[] = [
      { providerId: 'a', when: [{ field: 'type', op: '=', value: 'technical' }] },
    ]
    const result = await resolveProvider(choices, task({ type: 'functional' }), neverCalled)
    expect(result).toEqual({ kind: 'none' })
  })

  it('1 candidato tras filtrar → ese, sin llamar a classify', async () => {
    const choices: AgentProviderChoice[] = [
      { providerId: 'a', when: [{ field: 'type', op: '=', value: 'functional' }] },
      { providerId: 'b', when: [{ field: 'type', op: '=', value: 'technical' }] },
    ]
    const result = await resolveProvider(choices, task({ type: 'functional' }), neverCalled)
    expect(result).toEqual({ kind: 'resolved', providerId: 'a' })
  })

  it('>1 candidatos, ninguno con whenText → el primero por orden del array, sin llamar a classify', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), neverCalled)
    expect(result).toEqual({ kind: 'resolved', providerId: 'a' })
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
    expect(result).toEqual({ kind: 'resolved', providerId: 'b' })
  })

  it('classify devuelve null → none (falla el dispatch, no adivina)', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a', whenText: 'x' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), async () => null)
    expect(result).toEqual({ kind: 'none' })
  })

  it('classify devuelve un id fuera del set de candidatos → none', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a', whenText: 'x' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), async () => 'c')
    expect(result).toEqual({ kind: 'none' })
  })
})

describe('resolveProvider — capacidad', () => {
  const neverCalled = async (): Promise<string | null> => {
    throw new Error('classify no debería llamarse')
  }

  it('sin límites configurados se comporta igual que antes (regresión)', async () => {
    const result = await resolveProvider('anthropic-api', task(), neverCalled, {
      snapshot: running({ 'anthropic-api': 99 }),
    })
    expect(result).toEqual({ kind: 'resolved', providerId: 'anthropic-api' })
  })

  it('el primer candidato saturado cede el turno al siguiente', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), neverCalled, {
      limits: { a: { maxConcurrentRuns: 1 } },
      snapshot: running({ a: 1 }),
    })
    expect(result).toEqual({ kind: 'resolved', providerId: 'b' })
  })

  it('todos rechazan → saturated con el motivo de cada uno (para diferir, no para fallar)', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), neverCalled, {
      limits: { a: { maxConcurrentRuns: 1 }, b: { maxConcurrentRuns: 2 } },
      snapshot: running({ a: 1, b: 2 }),
    })
    expect(result.kind).toBe('saturated')
    expect(result).toMatchObject({
      declined: [
        { providerId: 'a', reason: expect.stringContaining('1/1') },
        { providerId: 'b', reason: expect.stringContaining('2/2') },
      ],
    })
  })

  it('un único candidato saturado también difiere — nunca cae a "correlo igual"', async () => {
    const result = await resolveProvider('anthropic-api', task(), neverCalled, {
      limits: { 'anthropic-api': { maxConcurrentRuns: 2 } },
      snapshot: running({ 'anthropic-api': 2 }),
    })
    expect(result.kind).toBe('saturated')
  })

  it('un cap de 0 no limita (mismo criterio que el resto de los caps)', async () => {
    const result = await resolveProvider('anthropic-api', task(), neverCalled, {
      limits: { 'anthropic-api': { maxConcurrentRuns: 0 } },
      snapshot: running({ 'anthropic-api': 7 }),
    })
    expect(result).toEqual({ kind: 'resolved', providerId: 'anthropic-api' })
  })

  it('un provider puede rechazar por sus propios motivos aunque el cap dé lugar', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'remote:1' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task(), neverCalled, {
      admit: async (id) =>
        id === 'remote:1' ? { accept: false, reason: 'RAM al límite' } : { accept: true },
    })
    expect(result).toEqual({ kind: 'resolved', providerId: 'b' })
  })

  it('el provider recibe la tarea, el agente y los números que el engine ya tiene', async () => {
    const seen: AdmissionRequest[] = []
    await resolveProvider(
      'anthropic-api',
      task({ id: 'task-9' }),
      neverCalled,
      {
        limits: { 'anthropic-api': { maxConcurrentRuns: 4 } },
        snapshot: running({ 'anthropic-api': 2 }),
        admit: async (_id, req) => {
          seen.push(req)
          return { accept: true }
        },
      },
      'builder',
    )
    expect(seen).toHaveLength(1)
    expect(seen[0].task.id).toBe('task-9')
    expect(seen[0].agentId).toBe('builder')
    expect(seen[0].running).toBe(2)
    expect(seen[0].cap).toBe(4)
  })

  it('un provider que rechaza por la tarea en sí (no por ocupación) también cede el turno', async () => {
    const choices: AgentProviderChoice[] = [{ providerId: 'a' }, { providerId: 'b' }]
    const result = await resolveProvider(choices, task({ repos: ['monorepo'] }), neverCalled, {
      admit: async (id, req) =>
        id === 'a' && req.task.repos?.includes('monorepo')
          ? { accept: false, reason: 'no tengo ese repo clonado' }
          : { accept: true },
    })
    expect(result).toEqual({ kind: 'resolved', providerId: 'b' })
  })

  it('el classifier sólo ve candidatos admitidos — no se le ofrece uno saturado', async () => {
    const choices: AgentProviderChoice[] = [
      { providerId: 'a', whenText: 'simples' },
      { providerId: 'b', whenText: 'complejas' },
      { providerId: 'c', whenText: 'lo que sea' },
    ]
    const seen: string[][] = []
    const result = await resolveProvider(
      choices,
      task(),
      async ({ candidates }) => {
        seen.push(candidates.map((c) => c.providerId))
        return 'c'
      },
      { limits: { a: { maxConcurrentRuns: 1 } }, snapshot: running({ a: 1 }) },
    )
    expect(seen).toEqual([['b', 'c']])
    expect(result).toEqual({ kind: 'resolved', providerId: 'c' })
  })

  it('sin `admit` inyectado igual vale el cap declarado — el default cubre a todo provider', async () => {
    // Es lo que hace que el número de la UI sirva para un provider que no
    // implementa `canAccept`: nadie escribe código y el cap se respeta.
    const result = await resolveProvider('anthropic-api', task(), neverCalled, {
      limits: { 'anthropic-api': { maxConcurrentRuns: 1 } },
      snapshot: running({ 'anthropic-api': 1 }),
    })
    expect(result.kind).toBe('saturated')
  })
})
