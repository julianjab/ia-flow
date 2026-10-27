import { describe, expect, it } from 'vitest'
import { EventFilter } from '../../condition/EventFilter.js'
import { createEvent } from '../../events/DomainEvent.js'
import { Pause } from '../../pipeline/actions/Pause.js'
import type { Runnable } from '../../pipeline/Runnable.js'
import { ExecutionStore } from '../ExecutionStore.js'
import { InMemoryExecutionRepository } from '../InMemoryExecutionRepository.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const pause = () =>
  new Pause('wait-ci', [{ name: 'green', filter: new EventFilter({ on: ['ci'] }) }], 5_000)
const checkpoint = {
  pipelineId: 'build',
  pauseId: 'wait-ci',
  resumeAt: 1,
  steps: {},
  shape: 'implementer → wait-ci',
}
const agent = { id: 'implementer', kind: 'agent', accepts: () => false } as unknown as Runnable
const newStore = () => new ExecutionStore({ repository: new InMemoryExecutionRepository() })

describe('ExecutionStore.cancel', () => {
  it('una pausada cierra superseded con el motivo: ya no vence ni despierta', async () => {
    const store = newStore()
    const execution = await store.start({ key: 't', pipelineId: 'build' })
    await execution.run(async () => execution.pause(pause(), checkpoint))

    expect(store.cancel('t', 'la tomó una sesión local')).toEqual({
      execution: execution.id,
      waiting: false,
    })
    expect(execution.status).toBe('superseded')
    expect(execution.toRecord().closeReason).toBe('la tomó una sesión local')
    expect(execution.expired(Number.POSITIVE_INFINITY)).toBe(false)
    expect(execution.wake(createEvent('ci', {}))).toBeUndefined()
    expect(store.paused()).toEqual([])
  })

  it('una que corre queda interrumpida: su agente lee el aviso y cierra superseded', async () => {
    const store = newStore()
    const execution = await store.start({ key: 't', pipelineId: 'build' })
    const run = execution.run(async () => {
      execution.enter(agent)
      await tick()
      return execution.drain(agent)
    })
    store.cancel('t', 'la tomó una sesión local')

    const read = await run
    expect(read.join('\n')).toMatch(/se cancela: la tomó una sesión local/)
    expect(execution.interruption?.by).toBe('cancel')
    expect(execution.status).toBe('superseded')
    expect(execution.toRecord().closeReason).toBe('la tomó una sesión local')
  })

  it('también corta entre pasos, sin agente activo (la pipeline no sigue do[])', async () => {
    const store = newStore()
    const execution = await store.start({ key: 't', pipelineId: 'build' })
    const run = execution.run(async () => tick())
    expect(store.cancel('t', 'motivo').execution).toBe(execution.id)
    expect(execution.interruption?.reason).toBe('motivo')
    await run
    expect(execution.status).toBe('superseded')
  })

  it('las corridas que esperaban turno ceden sin arrancar; las que llegan después corren', async () => {
    const store = newStore()
    const running = await store.start({ key: 't', pipelineId: 'build' })
    const queued = store.start({ key: 't', pipelineId: 'review', ifQueued: 'keep' })
    await tick()

    expect(store.cancel('t', 'la tomó una sesión local').waiting).toBe(true)
    running.close('done')
    expect(await queued).toBeUndefined()

    const later = await store.start({ key: 't', pipelineId: 'review', ifQueued: 'keep' })
    expect(later?.status).toBe('running')
    later?.close('done')
  })

  it('una task sin nada vivo no corta nada', () => {
    expect(newStore().cancel('t', 'motivo')).toEqual({ waiting: false })
  })
})
