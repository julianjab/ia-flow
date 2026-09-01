import { describe, expect, test } from 'bun:test'
import type { EngineEvent } from '@ia-flow/shared'
import type { EventOutcome, IEventBus } from '../../../domain/ports/IEventBus.js'
import type { IssueItem } from '../../../domain/ports/IIssueManager.js'
import type { ISeenItemRepository } from '../../../domain/ports/ISeenItemRepository.js'
import { PublishScannedItemUseCase } from '../PublishScannedItemUseCase.js'

function harness(
  opts: { seeded?: Record<string, string>; failDiff?: boolean; outcome?: EventOutcome } = {},
) {
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
      return opts.outcome ?? 'dispatched'
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
  test('un cambio de status publica el diff, con el item completo', async () => {
    const { uc, published } = harness({ seeded: { i1: 'Todo' } })

    const outcome = await uc.execute(item({ status: 'In Progress' }))

    expect(published).toHaveLength(1)
    expect(published[0]?.type).toBe('issue.status_changed')
    expect((published[0]?.payload as { item: IssueItem }).item.title).toBe('Arreglar el login')
    expect(outcome).toBe('dispatched')
  })

  test('sin cambio de status no publica nada, y devuelve skipped', async () => {
    const { uc, published } = harness({ seeded: { i1: 'Todo' } })

    const outcome = await uc.execute(item({ status: 'Todo' }))

    expect(published).toHaveLength(0)
    expect(outcome).toBe('skipped')
  })

  // Sin esto el primer scan de un board de 200 issues emitiría 200
  // `issue.created`, y las reglas dispararían sobre issues que nadie tocó.
  test('el primer scan de un proyecto aprende pero no emite nada', async () => {
    const { uc, published, store } = harness()

    const outcome = await uc.execute(item())

    expect(published).toHaveLength(0)
    expect(store.get('i1')).toBe('Todo')
    expect(outcome).toBe('skipped')
  })

  test('un item nunca visto (no bootstrap) es issue.created', async () => {
    const { uc, published } = harness({ seeded: { other: 'Todo' } })

    await uc.execute(item())

    expect(published.map((e) => e.type)).toEqual(['issue.created'])
  })

  test('un outcome deferred NO aprende el status — el próximo scan reintenta el mismo diff', async () => {
    const { uc, store } = harness({ seeded: { i1: 'Todo' }, outcome: 'deferred' })

    const outcome = await uc.execute(item({ status: 'In Progress' }))

    expect(outcome).toBe('deferred')
    expect(store.get('i1')).toBe('Todo')
  })

  // El diff es aditivo: romper el scan por él cambiaría una mejora por una
  // regresión. Sin nada que publicar, el resultado es skipped.
  test('si el diff falla, se loguea y no se publica nada', async () => {
    const { uc, published, diffErrors } = harness({ failDiff: true })

    const outcome = await uc.execute(item())

    expect(diffErrors).toHaveLength(1)
    expect(published).toHaveLength(0)
    expect(outcome).toBe('skipped')
  })

  test('un item sin proyecto se saltea sin tocar el diff', async () => {
    const { uc, published, diffErrors } = harness({ failDiff: true })

    const outcome = await uc.execute(item({ projectId: undefined }))

    expect(published).toHaveLength(0)
    expect(diffErrors).toHaveLength(0)
    expect(outcome).toBe('skipped')
  })
})
