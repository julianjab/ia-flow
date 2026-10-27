import { describe, expect, it } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import { ExecutionStore } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'

const event = (issue: number) => createEvent('issue.status_changed', { to: 'Refine', issue })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ExecutionStore — una corrida que espera lugar', () => {
  it('queda anotada con su evento mientras espera, y hasta que la ejecución guarda por dónde seguir', async () => {
    const repository = new InMemoryExecutionRepository()
    const store = new ExecutionStore({ repository, maxConcurrent: 1 })
    const first = await store.start({ key: 'a', pipelineId: 'refine', event: event(1) })
    const queued = event(2)
    const second = store.start({ key: 'b', pipelineId: 'refine', event: queued })
    await tick()

    const keys = () => repository.waiting().map((run) => run.key)
    expect(repository.waiting().map((run) => [run.key, run.pipelineId, run.event])).toEqual([
      ['a', 'refine', expect.anything()],
      ['b', 'refine', queued],
    ])

    first.close('done')
    const started = await second
    expect(started.key).toBe('b')
    // Arrancó, pero todavía no guardó nada: si el proceso muere acá, su evento se re-despacha.
    expect(keys()).toEqual(['b'])
    started.progress({
      pipelineId: 'refine',
      pauseId: 'refiner',
      resumeAt: 0,
      steps: {},
      shape: 'refiner',
      state: ['c'],
    })
    expect(keys()).toEqual([])
    started.close('done')
  })

  it('una que arrancó y cierra (o se pausa) sin guardar progreso también se borra', async () => {
    const repository = new InMemoryExecutionRepository()
    const store = new ExecutionStore({ repository })
    const execution = await store.start({ key: 'a', pipelineId: 'refine', event: event(1) })
    expect(repository.waiting()).toHaveLength(1)
    execution.close('done')
    expect(repository.waiting()).toEqual([])
  })

  it('la que arrancó y murió con el proceso antes de guardar progreso re-despacha su evento (subscriptions#2041)', async () => {
    const repository = new InMemoryExecutionRepository()
    const trigger = event(1)
    await new ExecutionStore({ repository }).start({
      key: 'a',
      pipelineId: 'refine',
      event: trigger,
    })

    // Reinicio: la ejecución se cierra `interrupted` y su evento vuelve a pasar por las reglas.
    const restarted = new ExecutionStore({ repository })
    expect(repository.live()).toEqual([])
    expect(restarted.takeOrphaned()).toEqual([
      { executionId: expect.any(String), events: [trigger] },
    ])
    expect(repository.waiting()).toEqual([])
  })

  it('una reemplazada por otra de la misma pipeline tampoco queda anotada', async () => {
    const repository = new InMemoryExecutionRepository()
    const store = new ExecutionStore({ repository, maxConcurrent: 1 })
    const first = await store.start({ key: 'a', pipelineId: 'refine', event: event(1) })
    const older = store.start({
      key: 'b',
      pipelineId: 'refine',
      ifQueued: 'replace',
      event: event(2),
    })
    const newer = store.start({
      key: 'b',
      pipelineId: 'refine',
      ifQueued: 'replace',
      event: event(3),
    })
    await tick()
    // La que corre (`a`, sin progreso guardado) y las dos que esperan.
    expect(repository.waiting()).toHaveLength(3)

    first.close('done')
    expect(await older).toBeUndefined()
    ;(await newer)?.close('done')
    expect(repository.waiting()).toEqual([])
  })

  it('las que esperaban cuando el proceso murió se re-despachan al reiniciar, una vez por evento', () => {
    const repository = new InMemoryExecutionRepository()
    const lost = event(2)
    repository.queued({ id: 'q1', key: 'b', pipelineId: 'refine', queuedAt: '', event: lost })
    // El mismo evento encoló dos pipelines: se re-despacha una vez y decide las dos de nuevo.
    repository.queued({ id: 'q2', key: 'b', pipelineId: 'notify', queuedAt: '', event: lost })

    const store = new ExecutionStore({ repository })

    expect(store.takeOrphaned()).toEqual([{ executionId: 'q1', events: [lost] }])
    expect(repository.waiting()).toEqual([])
    expect(store.busy('b')).toBe(false)
  })

  it('sin el evento (un caller que no lo pasa) no anota nada, como antes', async () => {
    const repository = new InMemoryExecutionRepository()
    const store = new ExecutionStore({ repository, maxConcurrent: 1 })
    const first = await store.start({ key: 'a', pipelineId: 'refine' })
    const second = store.start({ key: 'b', pipelineId: 'refine' })
    await tick()

    expect(repository.waiting()).toEqual([])
    first.close('done')
    ;(await second).close('done')
  })
})
