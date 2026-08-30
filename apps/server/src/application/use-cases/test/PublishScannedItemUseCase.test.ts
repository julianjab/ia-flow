import { describe, expect, test } from 'bun:test'
import type { EngineEvent } from '@ia-flow/shared'
import type { IEventBus } from '../../../domain/ports/IEventBus.js'
import type { IssueItem } from '../../../domain/ports/IIssueManager.js'
import type { ISeenItemRepository } from '../../../domain/ports/ISeenItemRepository.js'
import { PublishScannedItemUseCase } from '../PublishScannedItemUseCase.js'

function harness(opts: { seeded?: Record<string, string>; failDiff?: boolean } = {}) {
  const store = new Map(Object.entries(opts.seeded ?? {}))
  const published: EngineEvent[] = []
  const diffErrors: unknown[] = []

  const seen: ISeenItemRepository = {
    get: (_p, id) => {
      if (opts.failDiff) throw new Error('store roto')
      return store.get(id)
    },
    set: (_p, id, status) => {
      store.set(id, status)
    },
    hasSeen: () => store.size > 0,
  }
  const bus: IEventBus = {
    subscribe: () => () => {},
    publish: async (e) => {
      published.push(e)
      return 'dispatched'
    },
  }

  return {
    uc: new PublishScannedItemUseCase(seen, bus, { onDiffError: (err) => diffErrors.push(err) }),
    published,
    diffErrors,
    store,
  }
}

const item = (over: Partial<IssueItem> = {}): IssueItem =>
  ({
    id: 'i1',
    projectId: 'p1',
    title: 'Arreglar el login',
    status: 'Todo',
    repos: ['web'],
    ...over,
  }) as IssueItem

describe('PublishScannedItemUseCase', () => {
  // Los dos, no uno: `issue.scanned` es sobre lo que condiciona el roster
  // migrado, y el diff es el hecho con identidad.
  test('un cambio de status publica el diff Y el issue.scanned', async () => {
    const { uc, published } = harness({ seeded: { i1: 'Todo' } })

    await uc.execute(item({ status: 'In Progress' }))

    expect(published).toHaveLength(2)
    expect(published[0]?.type).toBe('issue.status_changed')
    expect(published[1]?.type).toBe('issue.scanned')
  })

  test('sin cambio de status sólo publica issue.scanned', async () => {
    const { uc, published } = harness({ seeded: { i1: 'Todo' } })

    await uc.execute(item({ status: 'Todo' }))

    expect(published.map((e) => e.type)).toEqual(['issue.scanned'])
  })

  // Sin esto el primer scan de un board de 200 issues emitiría 200
  // `issue.created`, y las reglas dispararían sobre issues que nadie tocó.
  test('el primer scan de un proyecto aprende pero no emite el diff', async () => {
    const { uc, published, store } = harness()

    await uc.execute(item())

    expect(published.map((e) => e.type)).toEqual(['issue.scanned'])
    expect(store.get('i1')).toBe('Todo')
  })

  // El outcome es el de `issue.scanned`: es el que SourceDispatcher usa para
  // decidir si el item vuelve al backlog.
  test('devuelve el outcome del issue.scanned', async () => {
    const { uc } = harness({ seeded: { i1: 'Todo' } })
    expect(await uc.execute(item({ status: 'Done' }))).toBe('dispatched')
  })

  // El diff es aditivo: romper el scan por él cambiaría una mejora por una
  // regresión.
  test('si el diff falla, el issue.scanned sale igual', async () => {
    const { uc, published, diffErrors } = harness({ failDiff: true })

    const outcome = await uc.execute(item())

    expect(diffErrors).toHaveLength(1)
    expect(published.map((e) => e.type)).toEqual(['issue.scanned'])
    expect(outcome).toBe('dispatched')
  })

  test('un item sin proyecto se publica sin pasar por el diff', async () => {
    const { uc, published } = harness({ failDiff: true })

    await uc.execute(item({ projectId: undefined }))

    expect(published.map((e) => e.type)).toEqual(['issue.scanned'])
  })
})
