import { describe, expect, it } from 'vitest'
import { Agent } from '../agent/Agent.js'
import { ProviderRegistry } from '../agent/Provider.js'
import { Condition } from '../condition/Condition.js'
import { EventFilter } from '../condition/EventFilter.js'
import { Engine, scopeExecutionKey } from '../engine/Engine.js'
import type { ExecutionStore } from '../engine/ExecutionStore.js'
import { createEvent, type DomainEvent } from '../events/DomainEvent.js'
import { EventBus } from '../events/EventBus.js'
import { FunctionAction } from '../pipeline/actions/FunctionAction.js'
import { Pause } from '../pipeline/actions/Pause.js'
import { PauseAction } from '../pipeline/actions/PauseAction.js'
import type { Checkpoint } from '../pipeline/Pipeline.js'
import { Pipeline } from '../pipeline/Pipeline.js'

export interface ExecutionStoreFactoryOptions {
  maxConcurrent?: number
}

/** Arma un store vacío para un caso. Puede ser async (abrir una base, correr migraciones). */
export type ExecutionStoreFactory = (
  options: ExecutionStoreFactoryOptions,
) => ExecutionStore | Promise<ExecutionStore>

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const pause = (expiresAt?: number) =>
  new Pause('wait-ci', [{ name: 'green', filter: new EventFilter({ on: ['ci'] }) }], expiresAt)

const checkpoint = (key: string): Checkpoint => ({
  pipelineId: 'build',
  pauseId: 'wait-ci',
  resumeAt: 1,
  steps: { implementer: { exit: 'done' } },
  shape: 'implementer → wait-ci',
  scope: { task: key },
})

/**
 * Lo que cualquier `ExecutionStore` tiene que cumplir para que el `Engine` lo use en lugar del
 * store en memoria: serie por task, tope global, pausas que no ocupan la task, reemplazo
 * (`supersede`) o espera (`ifPaused: 'wait'`) de una pausa, y el inbox de cada ejecución. Un
 * adaptador (SQLite, otro) que pasa esta suite se puede sustituir sin cambiar el engine.
 */
export function executionStoreContract(name: string, makeStore: ExecutionStoreFactory): void {
  describe(`ExecutionStore contract: ${name}`, () => {
    it('opens a running execution per task and frees the task when it closes', async () => {
      const store = await makeStore({})
      const execution = await store.start({ key: 'task-1', pipelineId: 'build' })

      expect(execution.status).toBe('running')
      expect(store.current('task-1')).toBe(execution)
      expect(store.busy('task-1')).toBe(true)
      expect(store.stats).toEqual({ running: 1, waiting: 0, paused: 0 })

      execution.close('done')
      await tick()
      expect(store.current('task-1')).toBeUndefined()
      expect(store.busy('task-1')).toBe(false)
      expect(store.stats).toEqual({ running: 0, waiting: 0, paused: 0 })
    })

    it('marks the task busy in the same tick start is called', async () => {
      const store = await makeStore({})
      void store.start({ key: 'task-1', pipelineId: 'build' })
      expect(store.busy('task-1')).toBe(true)
      expect(store.current('task-1')).toBeUndefined()
    })

    it('gives each execution its own id', async () => {
      const store = await makeStore({})
      const a = await store.start({ key: 'task-a', pipelineId: 'build' })
      const b = await store.start({ key: 'task-b', pipelineId: 'build' })
      expect(a.id).not.toBe(b.id)
    })

    it('never runs two executions of the same task at once', async () => {
      const store = await makeStore({})
      const first = await store.start({ key: 'task-1', pipelineId: 'build' })
      let secondStarted = false
      const second = store.start({ key: 'task-1', pipelineId: 'ci-red' }).then((execution) => {
        secondStarted = true
        return execution
      })

      await tick()
      expect(secondStarted).toBe(false)
      expect(store.stats.waiting).toBe(1)

      first.close('failed')
      const started = await second
      expect(started.pipelineId).toBe('ci-red')
      expect(store.current('task-1')).toBe(started)
    })

    it('ifQueued replace: a newer run of the same pipeline replaces the one still waiting', async () => {
      const store = await makeStore({})
      // Arranca en el acto (task libre): no queda en cola, nadie la reemplaza.
      const running = await store.start({ key: 'task-1', pipelineId: 'review' })
      const older = store.start({ key: 'task-1', pipelineId: 'review', ifQueued: 'replace' })
      const other = store.start({ key: 'task-1', pipelineId: 'comment', ifQueued: 'replace' })
      const newer = store.start({ key: 'task-1', pipelineId: 'review', ifQueued: 'replace' })

      running.close('done')
      // La que esperaba cede sin arrancar; otra pipeline no se toca; la nueva corre al final.
      expect(await older).toBeUndefined()
      const comment = await other
      expect(comment?.pipelineId).toBe('comment')
      comment?.close('done')
      const review = await newer
      expect(review?.pipelineId).toBe('review')
      expect(store.current('task-1')).toBe(review)
      // La que ya corre nunca se reemplaza.
      expect(running.status).toBe('done')
    })

    it('ifQueued keep: every run of the same pipeline waits its turn', async () => {
      const store = await makeStore({})
      const running = await store.start({ key: 'task-1', pipelineId: 'comment' })
      const first = store.start({ key: 'task-1', pipelineId: 'comment', ifQueued: 'keep' })
      const second = store.start({ key: 'task-1', pipelineId: 'comment', ifQueued: 'replace' })

      running.close('done')
      const a = await first
      expect(a?.pipelineId).toBe('comment')
      a?.close('done')
      expect((await second)?.pipelineId).toBe('comment')
    })

    it('runs different tasks in parallel up to the global cap', async () => {
      const store = await makeStore({ maxConcurrent: 1 })
      const a = await store.start({ key: 'task-a', pipelineId: 'p' })
      let bStarted = false
      const b = store.start({ key: 'task-b', pipelineId: 'p' }).then((execution) => {
        bStarted = true
        return execution
      })

      await tick()
      expect(bStarted).toBe(false)
      a.close('done')
      expect((await b).key).toBe('task-b')
      expect(store.stats.running).toBe(1)
    })

    it('runs work as the execution: done on success, failed on a throw', async () => {
      const store = await makeStore({})
      const ok = await store.start({ key: 'task-1', pipelineId: 'build' })
      expect(await ok.run(async () => 'listo')).toBe('listo')
      expect(ok.status).toBe('done')

      const bad = await store.start({ key: 'task-1', pipelineId: 'build' })
      await expect(bad.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
      expect(bad.status).toBe('failed')
      await tick()
      expect(store.busy('task-1')).toBe(false)
    })

    it('a paused execution frees the task and its slot, and is listed as paused', async () => {
      const store = await makeStore({ maxConcurrent: 1 })
      const execution = await store.start({ key: 'task-1', pipelineId: 'build' })
      await execution.run(async () => execution.pause(pause(), checkpoint('task-1')))

      expect(execution.status).toBe('paused')
      expect(store.current('task-1')).toBe(execution)
      expect(store.busy('task-1')).toBe(false)
      expect(store.paused()).toEqual([execution])
      expect(store.stats).toEqual({ running: 0, waiting: 0, paused: 1 })
      // El lugar quedó libre: otra task arranca.
      const other = await store.start({ key: 'task-2', pipelineId: 'build' })
      expect(other.status).toBe('running')
    })

    it('a woken execution is re-admitted with resume and continues from its checkpoint', async () => {
      const store = await makeStore({})
      const execution = await store.start({ key: 'task-1', pipelineId: 'build' })
      await execution.run(async () => execution.pause(pause(), checkpoint('task-1')))

      expect(execution.wake(createEvent('other', {}))).toBeUndefined()
      const wake = execution.wake(createEvent('ci', {}))
      expect(wake?.branch).toBe('green')
      expect(wake?.checkpoint).toEqual(checkpoint('task-1'))
      expect(execution.status).toBe('running')

      await store.resume(execution)
      expect(store.busy('task-1')).toBe(true)
      await execution.run(async () => undefined)
      expect(execution.status).toBe('done')
      await tick()
      expect(store.current('task-1')).toBeUndefined()
    })

    it('an expired pause wakes through the timeout branch', async () => {
      const store = await makeStore({})
      const execution = await store.start({ key: 'task-1', pipelineId: 'build' })
      await execution.run(async () => execution.pause(pause(1_000), checkpoint('task-1')))

      expect(execution.expired(999)).toBe(false)
      expect(execution.expired(1_000)).toBe(true)
      expect(execution.wakeOnTimeout()?.branch).toBe('timeout')
    })

    it('a new start supersedes a paused execution of the same task', async () => {
      const store = await makeStore({})
      const paused = await store.start({ key: 'task-1', pipelineId: 'build' })
      await paused.run(async () => paused.pause(pause(), checkpoint('task-1')))

      const next = await store.start({ key: 'task-1', pipelineId: 'ci-red' })
      expect(paused.status).toBe('superseded')
      expect(store.current('task-1')).toBe(next)
      expect(store.paused()).toEqual([])
    })

    it("ifPaused 'wait' waits for the pause to end without holding the task", async () => {
      const store = await makeStore({})
      const paused = await store.start({ key: 'task-1', pipelineId: 'build' })
      await paused.run(async () => paused.pause(pause(), checkpoint('task-1')))

      let started = false
      const waiting = store
        .start({ key: 'task-1', pipelineId: 'triage', ifPaused: 'wait' })
        .then((execution) => {
          started = true
          return execution
        })
      await tick()
      expect(started).toBe(false)
      expect(store.busy('task-1')).toBe(false)

      // La pausa puede despertar y terminar mientras la otra espera.
      expect(paused.wake(createEvent('ci', {}))?.branch).toBe('green')
      await store.resume(paused)
      await paused.run(async () => undefined)
      const next = await waiting
      expect(paused.status).toBe('done')
      expect(next.pipelineId).toBe('triage')
    })

    it('keeps the inbox of its execution: delivered once, unread handed back once', async () => {
      const store = await makeStore({})
      const execution = await store.start({ key: 'task-1', pipelineId: 'build' })
      const comment = createEvent('issue_comment', {})
      const agent = new Agent({
        id: 'implementer',
        provider: 'fake',
        prompt: 'p',
        injects: [{ on: ['issue_comment'] }],
      })

      expect(execution.inject('antes', comment)).toBe(false)
      execution.enter(agent)
      expect(execution.inject('primero', comment)).toBe(true)
      expect(execution.drain()).toEqual(['primero'])
      expect(execution.inject('tarde', comment)).toBe(true)
      execution.leave()
      expect(execution.takeUnread()).toEqual([comment])
      expect(execution.takeUnread()).toEqual([])
    })

    it('drives an Engine through a pause and its resumption', async () => {
      const store = await makeStore({})
      const ran: string[] = []
      const step = (id: string) =>
        new FunctionAction({ id, fn: (ctx) => ran.push(`${id}:${ctx.event.type}`) })
      const registry = new ProviderRegistry().register({
        id: 'done',
        run: async (ctx) => {
          await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
          return { outcome: 'success' }
        },
      })
      const waitCi = new PauseAction({
        id: 'wait-ci',
        branches: {
          green: {
            on: ['check_suite'],
            when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
            to: step('review'),
          },
        },
      })
      const build = new Pipeline({
        id: 'build',
        on: ['build'],
        do: [
          new Agent(
            { id: 'implementer', provider: 'done', prompt: 'p', routes: { done: { to: waitCi } } },
            registry,
          ),
        ],
      })
      const engine = new Engine({
        bus: new EventBus(),
        pipelines: { list: () => [build] },
        executions: store,
      })
      const TASK = { projectId: 'p', issue: 7 }
      const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
        createEvent(type, payload, { scope: TASK })
      const key = scopeExecutionKey(event('x')) as string

      expect(await engine.dispatch(event('build'))).toBe('dispatched')
      expect(store.current(key)?.status).toBe('paused')
      expect(await engine.dispatch(event('check_suite', { conclusion: 'success' }))).toBe('resumed')
      expect(ran).toEqual(['review:check_suite'])
      await tick()
      expect(store.current(key)).toBeUndefined()
    })

    it('counts runs against a budget (maxRuns): admits up to max, then refuses', async () => {
      const store = await makeStore({})
      const budget = { counter: 'review-loop', max: 2 }
      expect(store.admitRun('task-a', budget, 1000)).toEqual({ allowed: true, count: 1 })
      expect(store.admitRun('task-a', budget, 2000)).toEqual({ allowed: true, count: 2 })
      expect(store.admitRun('task-a', budget, 3000)).toEqual({ allowed: false, count: 2 })
      // Otra task, y otro contador de la misma, cuentan aparte.
      expect(store.admitRun('task-b', budget, 3000)).toEqual({ allowed: true, count: 1 })
      expect(store.admitRun('task-a', { counter: 'ci-red', max: 1 }, 3000).allowed).toBe(true)
    })

    it('resets a counter (or all of a task), and a stale count starts over', async () => {
      const store = await makeStore({})
      const budget = { counter: 'loop', max: 1 }
      store.admitRun('task-a', budget, 1000)
      expect(store.admitRun('task-a', budget, 1000).allowed).toBe(false)
      store.resetRuns('task-a', 'loop')
      expect(store.admitRun('task-a', budget, 1000).allowed).toBe(true)
      store.resetRuns('task-a')
      expect(store.admitRun('task-a', budget, 1000).allowed).toBe(true)

      const windowed = { counter: 'w', max: 1, windowMs: 500 }
      store.admitRun('task-c', windowed, 1000)
      expect(store.admitRun('task-c', windowed, 1400).allowed).toBe(false)
      // Pasada la ventana desde la última contada, arranca de cero.
      expect(store.admitRun('task-c', windowed, 1600)).toEqual({ allowed: true, count: 1 })
    })
  })
}
