import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { type IfQueued, Pipeline } from '../../pipeline/Pipeline.js'
import { Engine } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const TASK = { projectId: 'p', repo: 'la-haus/subscriptions', issue: 1640 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK, depth: 1 })

/**
 * Un agente que anota cada corrida (`<pipeline>:<status del evento>`). La primera corrida queda
 * trabada hasta `release`: mientras tanto, la task está ocupada y lo que llega se encola.
 */
function recordingAgent() {
  const runs: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let started!: () => void
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  const agent = new Agent(
    { id: 'worker', provider: 'rec', prompt: 'p' },
    new ProviderRegistry().register({
      id: 'rec',
      run: async (ctx) => {
        const { status } = ctx.ctx.event.payload as { status?: string }
        runs.push(`${ctx.ctx.pipelineId}:${status ?? '-'}`)
        if (runs.length === 1) {
          started()
          await gate
        }
        return { outcome: 'success' }
      },
    }),
  )
  return { agent, runs, release, running }
}

function engineWith(pipelines: Pipeline[]) {
  return new Engine({
    bus: new EventBus(),
    pipelines: new StaticPipelineSource(pipelines),
    executions: new InMemoryExecutionStore(),
  })
}

const rule = (id: string, on: string, agent: Agent, ifQueued?: IfQueued) =>
  new Pipeline({ id, on: [on], do: [agent], ...(ifQueued ? { ifQueued } : {}) })

describe('Engine — ifQueued', () => {
  it('replace (default): two events for the same pipeline while the task is busy run it once, with the last one', async () => {
    const worker = recordingAgent()
    const engine = engineWith([
      rule('build', 'build', worker.agent),
      rule('status', 'status_changed', worker.agent),
    ])

    const build = engine.dispatch(event('build'))
    await worker.running
    const toReview = engine.dispatch(event('status_changed', { status: 'Review' }))
    const backToBuild = engine.dispatch(event('status_changed', { status: 'Build' }))
    worker.release()
    await Promise.all([build, toReview, backToBuild])

    expect(worker.runs).toEqual(['build:-', 'status:Build'])
  })

  it('keep: every event for the pipeline runs, in order', async () => {
    const worker = recordingAgent()
    const engine = engineWith([
      rule('build', 'build', worker.agent),
      rule('comment', 'issue_comment', worker.agent, 'keep'),
    ])

    const build = engine.dispatch(event('build'))
    await worker.running
    const first = engine.dispatch(event('issue_comment', { status: 'a' }))
    const second = engine.dispatch(event('issue_comment', { status: 'b' }))
    worker.release()
    await Promise.all([build, first, second])

    expect(worker.runs).toEqual(['build:-', 'comment:a', 'comment:b'])
  })

  it('only the same pipeline is replaced: different pipelines keep their place', async () => {
    const worker = recordingAgent()
    const engine = engineWith([
      rule('build', 'build', worker.agent),
      rule('review', 'to_review', worker.agent),
      rule('rebuild', 'to_build', worker.agent),
    ])

    const build = engine.dispatch(event('build'))
    await worker.running
    const review = engine.dispatch(event('to_review', { status: 'Review' }))
    const rebuild = engine.dispatch(event('to_build', { status: 'Build' }))
    worker.release()
    await Promise.all([build, review, rebuild])

    expect(worker.runs).toEqual(['build:-', 'review:Review', 'rebuild:Build'])
  })

  it('the run already going is never replaced: a new event for its own pipeline waits', async () => {
    const worker = recordingAgent()
    const engine = engineWith([rule('status', 'status_changed', worker.agent)])

    const first = engine.dispatch(event('status_changed', { status: 'Build' }))
    await worker.running
    const second = engine.dispatch(event('status_changed', { status: 'Review' }))
    worker.release()
    await Promise.all([first, second])

    expect(worker.runs).toEqual(['status:Build', 'status:Review'])
  })
})

describe('Engine — supersedes', () => {
  /** El caso de subscriptions#2042: con la task ocupada por el review, el merge de un hermano deja
   *  el PR en conflicto (`pr-conflict`) y el gate devuelve la card a Build (`build-reentry`). */
  const pipelines = (worker: ReturnType<typeof recordingAgent>) => [
    rule('review', 'review', worker.agent),
    rule('pr-conflict', 'pr_conflict', worker.agent),
    new Pipeline({
      id: 'build-reentry',
      on: ['status_changed'],
      supersedes: ['pr-conflict'],
      do: [worker.agent],
    }),
  ]

  it('a waiting run of a superseded pipeline does not start when the superseding one arrives', async () => {
    const worker = recordingAgent()
    const engine = engineWith(pipelines(worker))

    const review = engine.dispatch(event('review'))
    await worker.running
    const conflict = engine.dispatch(event('pr_conflict'))
    const reentry = engine.dispatch(event('status_changed', { status: 'Build' }))
    worker.release()
    await Promise.all([review, conflict, reentry])

    expect(worker.runs).toEqual(['review:-', 'build-reentry:Build'])
  })

  it('nor does one that arrives while the superseding one waits', async () => {
    const worker = recordingAgent()
    const engine = engineWith(pipelines(worker))

    const review = engine.dispatch(event('review'))
    await worker.running
    const reentry = engine.dispatch(event('status_changed', { status: 'Build' }))
    const conflict = engine.dispatch(event('pr_conflict'))
    worker.release()
    await Promise.all([review, reentry, conflict])

    expect(worker.runs).toEqual(['review:-', 'build-reentry:Build'])
  })

  it('the superseding run already going does not stop a later one: it waits and runs after', async () => {
    const worker = recordingAgent()
    const engine = engineWith(pipelines(worker))

    const reentry = engine.dispatch(event('status_changed', { status: 'Build' }))
    await worker.running
    const conflict = engine.dispatch(event('pr_conflict'))
    worker.release()
    await Promise.all([reentry, conflict])

    expect(worker.runs).toEqual(['build-reentry:Build', 'pr-conflict:-'])
  })

  it('a superseded run already going is not touched: the superseding one waits for it', async () => {
    const worker = recordingAgent()
    const engine = engineWith(pipelines(worker))

    const conflict = engine.dispatch(event('pr_conflict'))
    await worker.running
    const reentry = engine.dispatch(event('status_changed', { status: 'Build' }))
    worker.release()
    await Promise.all([conflict, reentry])

    expect(worker.runs).toEqual(['pr-conflict:-', 'build-reentry:Build'])
  })
})
