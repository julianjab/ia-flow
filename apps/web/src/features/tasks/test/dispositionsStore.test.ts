import type { TaskDispositionEntry } from '@ia-flow/shared'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchTaskDispositions = vi.fn<[string], Promise<TaskDispositionEntry[]>>()
vi.mock('@/features/tasks/api', () => ({
  fetchTaskDispositions: (pid: string) => fetchTaskDispositions(pid),
}))

import { useDispositionsStore } from '../dispositionsStore'

function entry(over: Partial<TaskDispositionEntry> = {}): TaskDispositionEntry {
  return {
    taskId: 't1',
    disposition: 'waiting-on-you',
    reason: 'falló 2× · no hay regla de retry',
    waitingOnYouSince: null,
    unblocks: 0,
    blockedBy: [],
    verb: null,
    ...over,
  }
}

describe('useDispositionsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    fetchTaskDispositions.mockReset()
    fetchTaskDispositions.mockResolvedValue([
      entry(),
      entry({ taskId: 't2', disposition: 'moving' }),
    ])
  })

  it('cachea por proyecto: el segundo consumidor no vuelve a pedirlo', async () => {
    // Es la razón de ser del store: la tab bar y la pantalla de Tareas piden
    // lo mismo, y el endpoint hace `getItems()` contra la fuente más los
    // blockers de cada ítem.
    const store = useDispositionsStore()
    await store.fetch('p1')
    await store.fetch('p1')

    expect(fetchTaskDispositions).toHaveBeenCalledTimes(1)
    expect(store.waitingCount('p1')).toBe(1)
  })

  it('dos fetch simultáneos comparten la promesa en vuelo', async () => {
    const store = useDispositionsStore()
    await Promise.all([store.fetch('p1'), store.fetch('p1')])

    expect(fetchTaskDispositions).toHaveBeenCalledTimes(1)
  })

  it('`force` sí refetchea — entrar a Tareas pide el estado de ahora', async () => {
    const store = useDispositionsStore()
    await store.fetch('p1')
    await store.fetch('p1', { force: true })

    expect(fetchTaskDispositions).toHaveBeenCalledTimes(2)
  })

  it('cada proyecto tiene su entrada: volver al anterior es gratis', async () => {
    const store = useDispositionsStore()
    await store.fetch('p1')
    fetchTaskDispositions.mockResolvedValue([])
    await store.fetch('p2')
    await store.fetch('p1')

    expect(fetchTaskDispositions).toHaveBeenCalledTimes(2)
    expect(store.waitingCount('p1')).toBe(1)
    expect(store.waitingCount('p2')).toBe(0)
  })

  it('un fallo NO deja el proyecto en vacío: son cosas distintas', async () => {
    // Con `[]` la pantalla no puede distinguir "no hay tareas" de "no se pudo
    // pedir", y el badge contaría cero sobre un dato que no llegó.
    const store = useDispositionsStore()
    fetchTaskDispositions.mockRejectedValue(new Error('502'))
    await store.fetch('p1')

    expect(store.hasFailed('p1')).toBe(true)
    expect(store.isLoaded('p1')).toBe(false)
  })

  it('sin proyecto no pide nada', async () => {
    const store = useDispositionsStore()
    await store.fetch(null)

    expect(fetchTaskDispositions).not.toHaveBeenCalled()
  })

  it('`force` no se cuelga de un fetch en vuelo: el ↺ pide el estado de ahora', async () => {
    // La tab bar dispara el suyo al montar; si el ↺ se dedupeaba contra esa
    // promesa, el operador tocaba refrescar y no pasaba nada.
    const store = useDispositionsStore()
    let resolveFirst: (v: TaskDispositionEntry[]) => void = () => {}
    fetchTaskDispositions.mockImplementationOnce(
      () => new Promise((res) => { resolveFirst = res }),
    )
    fetchTaskDispositions.mockResolvedValueOnce([entry({ taskId: 't9' })])

    const first = store.fetch('p1')
    // El request arranca en un microtask (`fetch` encadena), así que hay que
    // dejarlo salir antes de resolverlo a mano.
    await new Promise((r) => setTimeout(r, 0))
    const forced = store.fetch('p1', { force: true })
    resolveFirst([entry()])
    await Promise.all([first, forced])

    expect(fetchTaskDispositions).toHaveBeenCalledTimes(2)
    // Y gana el segundo, que es el que pidió el estado de ahora.
    expect(store.entriesFor('p1').map((e) => e.taskId)).toEqual(['t9'])
  })
})
