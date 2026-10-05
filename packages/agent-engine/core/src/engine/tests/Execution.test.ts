import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { createEvent } from '../../events/DomainEvent.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'

/** Lo común a cualquier store está en `contracts.test.ts` (`executionStoreContract`). */
describe('InMemoryExecutionStore', () => {
  it('offers an event to its active step, and hands out each accepted message once', async () => {
    const store = new InMemoryExecutionStore()
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' })
    const comment = createEvent('issue_comment', {})
    const implementer = new Agent({
      id: 'implementer',
      provider: 'fake',
      prompt: 'p',
      injects: [{ on: ['issue_comment'] }],
    })
    const reviewer = new Agent({ id: 'reviewer', provider: 'fake', prompt: 'p' })

    expect(execution.active).toBeUndefined()
    // Sin paso en su loop no hay quién lo lea.
    expect(execution.inject('antes', comment)).toBe(false)
    // Un paso que no acepta ese evento tampoco.
    execution.enter(reviewer)
    expect(execution.inject('otro', comment)).toBe(false)
    execution.leave()

    execution.enter(implementer)
    expect(execution.active).toBe(implementer)
    expect(execution.inject('otro tipo', createEvent('label', {}))).toBe(false)
    expect(execution.inject('primero', comment)).toBe(true)
    expect(execution.inject('segundo', comment)).toBe(true)
    expect(execution.drain()).toEqual(['primero', 'segundo'])
    expect(execution.drain()).toEqual([])
    expect(execution.takeUnread()).toEqual([])

    expect(execution.inject('tarde', comment)).toBe(true)
    execution.leave()
    expect(execution.active).toBeUndefined()
    expect(execution.takeUnread()).toEqual([comment])
    // Lo que ningún paso aceptó queda recordado para una pausa posterior — sin pausa, nada.
    expect(execution.takeMissedWake()).toBeUndefined()
    // Se toman una sola vez.
    expect(execution.takeUnread()).toEqual([])
  })

  it('knows the events born inside it', async () => {
    const execution = await new InMemoryExecutionStore().start({ key: 't', pipelineId: 'p' })
    expect(execution.owns(createEvent('x', {}, { executionId: execution.id }))).toBe(true)
    expect(execution.owns(createEvent('x', {}, { executionId: 'exec-otra' }))).toBe(false)
    expect(execution.owns(createEvent('x', {}))).toBe(false)
  })

  it('ignores a second close and rejects a cap below one', async () => {
    const store = new InMemoryExecutionStore()
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' })
    execution.close('done')
    execution.close('failed')
    expect(execution.status).toBe('done')
    expect(() => new InMemoryExecutionStore({ maxConcurrent: 0 })).toThrow(/maxConcurrent/)
  })

  it('interrupts only an agent in its loop, once, and closes superseded', async () => {
    const store = new InMemoryExecutionStore()
    const execution = await store.start({ key: 'task-1', pipelineId: 'build' })
    const interruption = { by: 'review', event: 'status_changed', reason: 'pasó a Review' }
    const implementer = new Agent({ id: 'implementer', provider: 'fake', prompt: 'p' })

    // Entre pasos no hay quién decida parar.
    expect(execution.interrupt(interruption, 'pará')).toBe(false)
    expect(execution.interruption).toBeUndefined()

    execution.enter(implementer)
    expect(execution.interrupt(interruption, 'pará')).toBe(true)
    expect(execution.interrupt({ ...interruption, by: 'otra' }, 'pará de nuevo')).toBe(false)
    expect(execution.interruption).toEqual(interruption)
    expect(execution.drain()).toEqual(['pará'])
    execution.leave()

    await execution.run(async () => undefined)
    expect(execution.status).toBe('superseded')
    expect(execution.toRecord().closeReason).toBe('interrupted by review')
    expect(store.busy('task-1')).toBe(false)
  })
})

describe('Execution.run', () => {
  it('closes failed with the error message as closeReason when the work throws', async () => {
    const execution = await new InMemoryExecutionStore().start({ key: 't', pipelineId: 'p' })
    await expect(
      execution.run(async () => {
        throw new Error('el provider se cayó')
      }),
    ).rejects.toThrow('el provider se cayó')
    expect(execution.status).toBe('failed')
    expect(execution.toRecord().closeReason).toBe('el provider se cayó')
  })

  describe('con varios pasos activos (un grupo `parallel`)', () => {
    const comment = createEvent('issue_comment', {})
    const reviewer = new Agent({
      id: 'reviewer',
      provider: 'fake',
      prompt: 'p',
      injects: [{ on: ['issue_comment'] }],
    })
    const e2e = new Agent({ id: 'e2e', provider: 'fake', prompt: 'p' })

    it('entrega a cada paso que lo acepta, y cada uno lee sólo lo suyo', async () => {
      const store = new InMemoryExecutionStore()
      const execution = await store.start({ key: 'task-1', pipelineId: 'review' })
      execution.enter(reviewer)
      execution.enter(e2e)
      expect(execution.activeSteps).toEqual([reviewer, e2e])
      // El primero que entró es el que se informa como paso activo.
      expect(execution.active).toBe(reviewer)

      expect(execution.inject('ojo con el null', comment)).toBe(true)
      expect(execution.drain(e2e)).toEqual([])
      expect(execution.drain(reviewer)).toEqual(['ojo con el null'])
    })

    it('salir de uno deja a los demás activos; sin paso, salen todos', async () => {
      const store = new InMemoryExecutionStore()
      const execution = await store.start({ key: 'task-2', pipelineId: 'review' })
      execution.enter(reviewer)
      execution.enter(e2e)
      execution.leave(reviewer)
      expect(execution.activeSteps).toEqual([e2e])
      // El reviewer ya no está en su loop: nadie más acepta el comentario.
      expect(execution.inject('tarde', comment)).toBe(false)
      execution.enter(reviewer)
      execution.leave()
      expect(execution.activeSteps).toEqual([])
    })

    it('una interrupción le avisa a cada agente activo', async () => {
      const store = new InMemoryExecutionStore()
      const execution = await store.start({ key: 'task-3', pipelineId: 'review' })
      execution.enter(reviewer)
      execution.enter(e2e)
      const interruption = { by: 'build', event: 'status_changed', reason: 'pasó a Build' }
      expect(execution.interrupt(interruption, 'pará')).toBe(true)
      expect(execution.drain(reviewer)).toEqual(['pará'])
      expect(execution.drain(e2e)).toEqual(['pará'])
    })

    it('un agente que entra DESPUÉS de la interrupción también lee el aviso', async () => {
      const store = new InMemoryExecutionStore()
      const execution = await store.start({ key: 'task-4', pipelineId: 'review' })
      execution.enter(reviewer)
      const interruption = { by: 'build', event: 'status_changed', reason: 'pasó a Build' }
      expect(execution.interrupt(interruption, 'pará')).toBe(true)
      // El e2e todavía preparaba su worktree: entra recién ahora.
      execution.enter(e2e)
      expect(execution.drain(e2e)).toEqual(['pará'])
      expect(execution.drain(reviewer)).toEqual(['pará'])
    })
  })
})
