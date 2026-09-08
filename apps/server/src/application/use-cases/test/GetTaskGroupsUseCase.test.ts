import { describe, expect, test } from 'bun:test'
import type { TaskDispositionEntry } from '@ia-flow/shared'
import type { SourceItem } from '../../../domain/ports/IIssueManager.js'
import type {
  IStructuredCompletion,
  StructuredCompletionRequest,
} from '../../../domain/ports/IStructuredCompletion.js'
import type { FocusSource } from '../GetTaskFocusUseCase.js'
import { GetTaskGroupsUseCase } from '../GetTaskGroupsUseCase.js'

function disposition(over: Partial<TaskDispositionEntry> = {}): TaskDispositionEntry {
  return {
    taskId: 't1',
    disposition: 'waiting-on-you',
    reason: 'falló 2× · no hay regla de retry',
    waitingOnYouSince: '2026-09-01T00:00:00.000Z',
    unblocks: 0,
    blockedBy: [],
    verb: null,
    ...over,
  }
}

function item(id: string, title = `tarea ${id}`): SourceItem {
  return { id, title, status: 'In progress' }
}

function source(items: SourceItem[]): FocusSource {
  return { getItems: async () => items }
}

class FakeCompletion implements IStructuredCompletion {
  calls: StructuredCompletionRequest[] = []
  constructor(
    private readonly reply: Record<string, unknown> | null | (() => never),
    private readonly available = true,
  ) {}
  isAvailable(): boolean {
    return this.available
  }
  async complete(req: StructuredCompletionRequest): Promise<Record<string, unknown> | null> {
    this.calls.push(req)
    if (typeof this.reply === 'function') return this.reply()
    return this.reply
  }
}

function build(
  completion: IStructuredCompletion,
  dispositions: TaskDispositionEntry[],
  opts: { enabled?: boolean } = {},
) {
  return new GetTaskGroupsUseCase({
    completion,
    loadDispositions: async () => dispositions,
    enabled: () => opts.enabled ?? true,
    now: () => new Date('2026-09-07T12:00:00.000Z'),
  })
}

const FOUR = ['t1', 't2', 't3', 't4'].map((id) => disposition({ taskId: id }))
const FOUR_ITEMS = ['t1', 't2', 't3', 't4'].map((id) => item(id))

describe('GetTaskGroupsUseCase', () => {
  test('devuelve los grupos con el momento del cómputo', async () => {
    const uc = build(
      new FakeCompletion({ groups: [{ label: 'auth', taskIds: ['t1', 't2'] }] }),
      FOUR,
    )
    const groups = await uc.execute('p1', source(FOUR_ITEMS))
    expect(groups?.groups).toEqual([{ label: 'auth', taskIds: ['t1', 't2'] }])
    expect(groups?.computedAt).toBe('2026-09-07T12:00:00.000Z')
  })

  test('apagado por configuración: null sin llamar al modelo', async () => {
    const completion = new FakeCompletion({ groups: [] })
    const uc = build(completion, FOUR, { enabled: false })
    expect(await uc.execute('p1', source(FOUR_ITEMS))).toBeNull()
    expect(completion.calls).toHaveLength(0)
  })

  test('sin credencial: null sin llamar al modelo', async () => {
    const completion = new FakeCompletion({ groups: [] }, false)
    const uc = build(completion, FOUR)
    expect(await uc.execute('p1', source(FOUR_ITEMS))).toBeNull()
    expect(completion.calls).toHaveLength(0)
  })

  test('una sola tarea no da material', async () => {
    const completion = new FakeCompletion({ groups: [] })
    const uc = build(completion, [disposition({ taskId: 't1' })])
    expect(await uc.execute('p1', source([item('t1')]))).toBeNull()
    expect(completion.calls).toHaveLength(0)
  })

  test('sólo mira el bucket que te espera', async () => {
    const completion = new FakeCompletion({ groups: [] })
    const uc = build(completion, [
      disposition({ taskId: 't1' }),
      disposition({ taskId: 't2' }),
      disposition({ taskId: 't3', disposition: 'moving' }),
      disposition({ taskId: 't4', disposition: 'closed' }),
    ])
    await uc.execute('p1', source(FOUR_ITEMS))
    const user = completion.calls[0]?.user ?? ''
    expect(user).toContain('t1')
    expect(user).toContain('t2')
    expect(user).not.toContain('t3')
    expect(user).not.toContain('t4')
  })

  test('un fallo del modelo se propaga', () => {
    const uc = build(
      new FakeCompletion(() => {
        throw new Error('Haiku 429')
      }),
      FOUR,
    )
    return expect(uc.execute('p1', source(FOUR_ITEMS))).rejects.toThrow('Haiku 429')
  })

  test('el modelo no llenó la tool: null', async () => {
    const uc = build(new FakeCompletion(null), FOUR)
    expect(await uc.execute('p1', source(FOUR_ITEMS))).toBeNull()
  })

  describe('saneamiento y reorden', () => {
    test('descarta un taskId que no estaba en la lista', async () => {
      const uc = build(
        new FakeCompletion({ groups: [{ label: 'x', taskIds: ['t1', 'inventado'] }] }),
        [disposition({ taskId: 't1' }), disposition({ taskId: 't2' })],
      )
      const groups = await uc.execute('p1', source([item('t1'), item('t2')]))
      // Sin 'inventado' el grupo queda con una sola tarea: no agrupa nada.
      expect(groups?.groups).toEqual([])
    })

    test('un grupo de una sola tarea se descarta', async () => {
      const uc = build(new FakeCompletion({ groups: [{ label: 'solo', taskIds: ['t1'] }] }), FOUR)
      const groups = await uc.execute('p1', source(FOUR_ITEMS))
      expect(groups?.groups).toEqual([])
    })

    test('una tarea repetida entre grupos se queda en el primero', async () => {
      const uc = build(
        new FakeCompletion({
          groups: [
            { label: 'primero', taskIds: ['t1', 't2'] },
            { label: 'segundo', taskIds: ['t2', 't3'] },
          ],
        }),
        FOUR,
      )
      const groups = await uc.execute('p1', source(FOUR_ITEMS))
      expect(groups?.groups).toEqual([{ label: 'primero', taskIds: ['t1', 't2'] }])
    })

    test('reordena los grupos por la mejor posición de sus integrantes, no por lo que dijo el modelo', async () => {
      // t3 está antes que t1 en el orden de disposiciones (ya calculado), así
      // que el grupo que lo contiene sube primero aunque el modelo lo haya
      // devuelto segundo.
      const dispositions = [
        disposition({ taskId: 't3' }),
        disposition({ taskId: 't4' }),
        disposition({ taskId: 't1' }),
        disposition({ taskId: 't2' }),
      ]
      const uc = build(
        new FakeCompletion({
          groups: [
            { label: 'tarde', taskIds: ['t1', 't2'] },
            { label: 'temprano', taskIds: ['t3', 't4'] },
          ],
        }),
        dispositions,
      )
      const groups = await uc.execute('p1', source(FOUR_ITEMS))
      expect(groups?.groups.map((g) => g.label)).toEqual(['temprano', 'tarde'])
    })
  })

  describe('cache por huella del contenido', () => {
    test('la misma lista no vuelve a pagar la llamada', async () => {
      const completion = new FakeCompletion({ groups: [] })
      const uc = build(completion, FOUR)
      await uc.execute('p1', source(FOUR_ITEMS))
      await uc.execute('p1', source(FOUR_ITEMS))
      expect(completion.calls).toHaveLength(1)
    })

    test('refresh saltea el cache', async () => {
      const completion = new FakeCompletion({ groups: [] })
      const uc = build(completion, FOUR)
      await uc.execute('p1', source(FOUR_ITEMS))
      await uc.execute('p1', source(FOUR_ITEMS), { refresh: true })
      expect(completion.calls).toHaveLength(2)
    })

    test('dos proyectos con la misma lista no comparten entrada', async () => {
      const completion = new FakeCompletion({ groups: [] })
      const uc = build(completion, FOUR)
      await uc.execute('p1', source(FOUR_ITEMS))
      await uc.execute('p2', source(FOUR_ITEMS))
      expect(completion.calls).toHaveLength(2)
    })
  })
})
