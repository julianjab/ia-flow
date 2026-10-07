import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine } from '../Engine.js'
import type { ExecutionRecord } from '../Execution.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const TASK = { projectId: 'p', repo: 'la-haus/subscriptions', issue: 'la-haus/subscriptions#1763' }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK, depth: 1 })

/**
 * Un agente que anota cada corrida (`<pipeline>:<status de la card en el evento>`). La primera
 * queda trabada hasta `release`: mientras tanto la task está ocupada y lo que llega espera.
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
        const item = (ctx.ctx.event.payload as { item?: { status?: string } }).item
        runs.push(`${ctx.ctx.pipelineId}:${item?.status ?? '-'}`)
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

/** El gate (`review`) ocupa la task; el e2e a pedido corre sólo con la card en Review. */
function setup(revalidate?: (event: DomainEvent<any>) => Promise<DomainEvent<any> | undefined>) {
  const worker = recordingAgent()
  const executions = new InMemoryExecutionStore()
  const closed: ExecutionRecord[] = []
  executions.observe((record) => {
    if (record.status !== 'running' && record.status !== 'paused') closed.push(record)
  })
  const engine = new Engine({
    bus: new EventBus(),
    pipelines: new StaticPipelineSource([
      new Pipeline({ id: 'review', on: ['issue.status_changed'], do: [worker.agent] }),
      new Pipeline({
        id: 'e2e-on-demand',
        on: ['issue.labeled'],
        when: [new Condition({ field: 'item.status', op: 'eq', value: 'Review' })],
        do: [worker.agent],
      }),
    ]),
    executions,
    ...(revalidate ? { revalidate } : {}),
  })
  return { engine, worker, closed }
}

const inReview = { item: { status: 'Review', labels: ['e2e-test'] } }
const movedTo = (status: string) => async (e: DomainEvent<any>) => ({
  ...e,
  payload: { ...e.payload, item: { ...(e.payload.item as object), status } },
})

describe('Engine — revalidate: una pipeline que esperó su turno vuelve a mirar los hechos', () => {
  it('no corre si lo que hizo la ejecución anterior la dejó sin efecto, y cierra diciendo por qué', async () => {
    const { engine, worker, closed } = setup(movedTo('Build'))

    const gate = engine.dispatch(event('issue.status_changed', inReview))
    await worker.running
    const labeled = engine.dispatch(event('issue.labeled', inReview))
    worker.release()
    await Promise.all([gate, labeled])

    expect(worker.runs).toEqual(['review:Review'])
    const e2e = closed.find((record) => record.pipelineId === 'e2e-on-demand')
    expect(e2e).toMatchObject({ status: 'superseded' })
    expect(e2e?.closeReason).toContain('ya no aplica al tomar su turno')
    expect(e2e?.closeReason).toContain('item.status')
  })

  it('si sigue aplicando, corre con los hechos de ahora', async () => {
    const revalidate = vi.fn(async (e: DomainEvent<any>) => ({
      ...e,
      payload: { ...e.payload, item: { status: 'Review', labels: ['e2e-test', 'reviewed'] } },
    }))
    const { engine, worker } = setup(revalidate)

    const gate = engine.dispatch(event('issue.status_changed', inReview))
    await worker.running
    const labeled = engine.dispatch(event('issue.labeled', inReview))
    worker.release()
    await Promise.all([gate, labeled])

    expect(worker.runs).toEqual(['review:Review', 'e2e-on-demand:Review'])
    expect(revalidate).toHaveBeenCalledTimes(1)
  })

  it('una que encuentra la task libre no relee nada', async () => {
    const revalidate = vi.fn(movedTo('Build'))
    const { engine, worker } = setup(revalidate)
    worker.release()

    await engine.dispatch(event('issue.labeled', inReview))

    expect(worker.runs).toEqual(['e2e-on-demand:Review'])
    expect(revalidate).not.toHaveBeenCalled()
  })

  it('si no se sabe (undefined) o la lectura falla, corre con el evento original, como antes', async () => {
    for (const revalidate of [
      async () => undefined,
      async () => {
        throw new Error('GitHub 502')
      },
    ]) {
      const { engine, worker } = setup(revalidate)
      const gate = engine.dispatch(event('issue.status_changed', inReview))
      await worker.running
      const labeled = engine.dispatch(event('issue.labeled', inReview))
      worker.release()
      await Promise.all([gate, labeled])

      expect(worker.runs).toEqual(['review:Review', 'e2e-on-demand:Review'])
    }
  })

  it('sin revalidate, como siempre: corre con lo que se decidió al llegar', async () => {
    const { engine, worker } = setup()
    const gate = engine.dispatch(event('issue.status_changed', inReview))
    await worker.running
    const labeled = engine.dispatch(event('issue.labeled', inReview))
    worker.release()
    await Promise.all([gate, labeled])

    expect(worker.runs).toEqual(['review:Review', 'e2e-on-demand:Review'])
  })
})
