import { describe, expect, test } from 'bun:test'
import type { TaskDispositionEntry } from '@ia-flow/shared'
import type { SourceItem } from '../../../domain/ports/IIssueManager.js'
import type {
  IStructuredCompletion,
  StructuredCompletionRequest,
} from '../../../domain/ports/IStructuredCompletion.js'
import { type FocusSource, GetTaskFocusUseCase } from '../GetTaskFocusUseCase.js'

// Todo lo que importa acá se decide con tres objetos literales: es la razón de
// que el use-case reciba las disposiciones por dep en vez de importar el otro.

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
  return new GetTaskFocusUseCase({
    completion,
    loadDispositions: async () => dispositions,
    enabled: () => opts.enabled ?? true,
    now: () => new Date('2026-09-07T12:00:00.000Z'),
  })
}

const TWO = [disposition({ taskId: 't1' }), disposition({ taskId: 't2' })]
const TWO_ITEMS = [item('t1'), item('t2')]

const OK_REPLY = {
  headline: 'Un solo cuello de botella: el PR #12 traba dos tareas.',
  picks: [{ taskId: 't1', why: 'El PR ya tiene CI verde.', effort: 'quick' }],
}

describe('GetTaskFocusUseCase', () => {
  test('devuelve el foco con el momento del cómputo, no el del pedido', async () => {
    const uc = build(new FakeCompletion(OK_REPLY), TWO)
    const focus = await uc.execute('p1', source(TWO_ITEMS))
    expect(focus?.headline).toBe(OK_REPLY.headline)
    expect(focus?.picks).toEqual([
      { taskId: 't1', why: 'El PR ya tiene CI verde.', effort: 'quick' },
    ])
    expect(focus?.computedAt).toBe('2026-09-07T12:00:00.000Z')
  })

  test('apagado por configuración: null sin llamar al modelo', async () => {
    const completion = new FakeCompletion(OK_REPLY)
    const uc = build(completion, TWO, { enabled: false })
    expect(await uc.execute('p1', source(TWO_ITEMS))).toBeNull()
    expect(completion.calls).toHaveLength(0)
  })

  test('sin credencial: null sin llamar al modelo', async () => {
    const completion = new FakeCompletion(OK_REPLY, false)
    const uc = build(completion, TWO)
    expect(await uc.execute('p1', source(TWO_ITEMS))).toBeNull()
    expect(completion.calls).toHaveLength(0)
  })

  test('una sola tarea esperándote no da material: la card repetiría la fila', async () => {
    const completion = new FakeCompletion(OK_REPLY)
    const uc = build(completion, [disposition({ taskId: 't1' })])
    expect(await uc.execute('p1', source([item('t1')]))).toBeNull()
    expect(completion.calls).toHaveLength(0)
  })

  test('sólo mira el bucket que te espera', async () => {
    const completion = new FakeCompletion(OK_REPLY)
    const uc = build(completion, [
      disposition({ taskId: 't1' }),
      disposition({ taskId: 't2' }),
      disposition({ taskId: 't3', disposition: 'moving' }),
      disposition({ taskId: 't4', disposition: 'closed' }),
    ])
    await uc.execute('p1', source([...TWO_ITEMS, item('t3'), item('t4')]))
    const user = completion.calls[0]?.user ?? ''
    expect(user).toContain('t1')
    expect(user).toContain('t2')
    expect(user).not.toContain('t3')
    expect(user).not.toContain('t4')
  })

  test('un fallo del modelo se propaga: es el estado degradado, no "no hay nada"', () => {
    const uc = build(
      new FakeCompletion(() => {
        throw new Error('Haiku 429')
      }),
      TWO,
    )
    return expect(uc.execute('p1', source(TWO_ITEMS))).rejects.toThrow('Haiku 429')
  })

  test('el modelo no llenó la tool: null, no una card vacía', async () => {
    const uc = build(new FakeCompletion(null), TWO)
    expect(await uc.execute('p1', source(TWO_ITEMS))).toBeNull()
  })

  describe('saneamiento de la salida', () => {
    test('descarta un taskId que no estaba en la lista', async () => {
      const uc = build(
        new FakeCompletion({
          headline: 'h',
          picks: [
            { taskId: 'inventado', why: 'w', effort: 'quick' },
            { taskId: 't2', why: 'w2', effort: 'deep' },
          ],
        }),
        TWO,
      )
      const focus = await uc.execute('p1', source(TWO_ITEMS))
      expect(focus?.picks.map((p) => p.taskId)).toEqual(['t2'])
    })

    test('sin headline no hay card: es lo único que se ve colapsada', async () => {
      const uc = build(
        new FakeCompletion({
          headline: '  ',
          picks: [{ taskId: 't1', why: 'w', effort: 'quick' }],
        }),
        TWO,
      )
      expect(await uc.execute('p1', source(TWO_ITEMS))).toBeNull()
    })

    test('sin picks válidos no hay card', async () => {
      const uc = build(
        new FakeCompletion({ headline: 'h', picks: [{ taskId: 'x', why: 'w', effort: 'quick' }] }),
        TWO,
      )
      expect(await uc.execute('p1', source(TWO_ITEMS))).toBeNull()
    })

    test('un effort desconocido cae en deep, que es la promesa conservadora', async () => {
      const uc = build(
        new FakeCompletion({ headline: 'h', picks: [{ taskId: 't1', why: 'w', effort: 'medio' }] }),
        TWO,
      )
      const focus = await uc.execute('p1', source(TWO_ITEMS))
      expect(focus?.picks[0]?.effort).toBe('deep')
    })

    test('corta el why en el último espacio, sin partir una palabra', async () => {
      const why = `${'palabra '.repeat(20)}final`
      const uc = build(
        new FakeCompletion({ headline: 'h', picks: [{ taskId: 't1', why, effort: 'quick' }] }),
        TWO,
      )
      const focus = await uc.execute('p1', source(TWO_ITEMS))
      const out = focus?.picks[0]?.why ?? ''
      expect(out.length).toBeLessThanOrEqual(90)
      expect(out.endsWith('…')).toBe(true)
      expect(out).not.toContain('palab…')
    })

    test('tope de tres picks, y no repite una tarea', async () => {
      const four = ['t1', 't2', 't3', 't4'].map((id) => disposition({ taskId: id }))
      const uc = build(
        new FakeCompletion({
          headline: 'h',
          picks: [
            { taskId: 't1', why: 'a', effort: 'quick' },
            { taskId: 't1', why: 'repetida', effort: 'quick' },
            { taskId: 't2', why: 'b', effort: 'quick' },
            { taskId: 't3', why: 'c', effort: 'quick' },
            { taskId: 't4', why: 'd', effort: 'quick' },
          ],
        }),
        four,
      )
      const focus = await uc.execute('p1', source(['t1', 't2', 't3', 't4'].map((id) => item(id))))
      expect(focus?.picks.map((p) => p.taskId)).toEqual(['t1', 't2', 't3'])
    })

    test('un cluster de una sola tarea no agrupa nada y se descarta', async () => {
      const uc = build(
        new FakeCompletion({
          headline: 'h',
          picks: [{ taskId: 't1', why: 'w', effort: 'quick' }],
          clusters: [
            { label: 'solo', taskIds: ['t1'] },
            { label: 'timeout de Twilio', taskIds: ['t1', 't2', 'inventado'] },
          ],
        }),
        TWO,
      )
      const focus = await uc.execute('p1', source(TWO_ITEMS))
      expect(focus?.clusters).toEqual([{ label: 'timeout de Twilio', taskIds: ['t1', 't2'] }])
    })
  })

  describe('cache por huella del contenido', () => {
    test('la misma lista no vuelve a pagar la llamada', async () => {
      const completion = new FakeCompletion(OK_REPLY)
      const uc = build(completion, TWO)
      await uc.execute('p1', source(TWO_ITEMS))
      await uc.execute('p1', source(TWO_ITEMS))
      expect(completion.calls).toHaveLength(1)
    })

    test('una razón que cambió recalcula sola, sin invalidar a mano', async () => {
      const completion = new FakeCompletion(OK_REPLY)
      const uc = new GetTaskFocusUseCase({
        completion,
        loadDispositions: async () => dispositions,
        enabled: () => true,
      })
      let dispositions = TWO
      await uc.execute('p1', source(TWO_ITEMS))
      dispositions = [
        disposition({ taskId: 't1', reason: 'ahora falló 3×' }),
        disposition({ taskId: 't2' }),
      ]
      await uc.execute('p1', source(TWO_ITEMS))
      expect(completion.calls).toHaveLength(2)
    })

    test('refresh saltea el cache: es el «reintentar» del estado degradado', async () => {
      const completion = new FakeCompletion(OK_REPLY)
      const uc = build(completion, TWO)
      await uc.execute('p1', source(TWO_ITEMS))
      await uc.execute('p1', source(TWO_ITEMS), { refresh: true })
      expect(completion.calls).toHaveLength(2)
    })

    test('dos proyectos con la misma lista no comparten entrada', async () => {
      const completion = new FakeCompletion(OK_REPLY)
      const uc = build(completion, TWO)
      await uc.execute('p1', source(TWO_ITEMS))
      await uc.execute('p2', source(TWO_ITEMS))
      expect(completion.calls).toHaveLength(2)
    })
  })
})
