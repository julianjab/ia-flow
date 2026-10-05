import { describe, expect, it } from 'bun:test'
import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { TaskDesk } from '../../inbox/TaskDesk.js'
import type { ActionContext } from '../defineAction.js'
import tasks from './tasks.js'

const ctxFor = (payload: Record<string, unknown>): PipelineExecutionContext => ({
  event: createEvent('human.x', payload),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'task-action:x',
})

function actionsFor(desk: TaskDesk) {
  const services = { tasks: desk } as unknown as ActionContext['services']
  const create = (id: string) => {
    const definition = tasks.find((candidate) => candidate.id === id)
    if (definition?.kind !== 'action') throw new Error(`falta ${id}`)
    return definition.create({ sourceId: 'p', options: {}, projects: () => [], services }) as {
      run(ctx: PipelineExecutionContext): Promise<string>
    }
  }
  return {
    redispatch: create('redispatch_task'),
    rerunReview: create('rerun_review'),
    stop: create('stop_agent'),
    resetRuns: create('reset_runs'),
  }
}

describe('redispatch_task / rerun_review', () => {
  it('ask the runner about the task of the event, as the person who asked', async () => {
    const calls: string[] = []
    const desk = new TaskDesk()
    desk.connect({
      redispatch: async (ref, by) => `${calls.push(`redispatch ${ref} ${by}`)}`,
      rerunReview: async (ref, by) => `${calls.push(`rerun ${ref} ${by}`)}`,
      stop: (ref, by) => `${calls.push(`stop ${ref} ${by}`)}`,
    })
    const { redispatch, rerunReview, stop } = actionsFor(desk)
    const ctx = ctxFor({ owner: 'o', repo: 'r', number: 7, actor: 'julian' })
    await redispatch.run(ctx)
    await rerunReview.run(ctx)
    await stop.run(ctx)
    expect(calls).toEqual(['redispatch o/r#7 julian', 'rerun o/r#7 julian', 'stop o/r#7 julian'])
  })

  it('refuse to run outside a task or when the runner is not serving the inbox', async () => {
    const { redispatch } = actionsFor(new TaskDesk())
    await expect(redispatch.run(ctxFor({}))).rejects.toThrow(/owner\/repo\/number/)
    await expect(
      redispatch.run(ctxFor({ owner: 'o', repo: 'r', number: 7, actor: 'julian' })),
    ).rejects.toThrow(/--serve/)
  })
})

describe('reset_runs', () => {
  it('le pide al runner que ponga en cero los topes de la task, a nombre de quien lo pidió', async () => {
    const calls: string[] = []
    const desk = new TaskDesk()
    desk.connect({
      redispatch: async () => '',
      rerunReview: async () => '',
      stop: () => '',
      resetRuns: (ref, by) => `${calls.push(`reset ${ref} ${by}`)}`,
    })
    await actionsFor(desk).resetRuns.run(
      ctxFor({ owner: 'o', repo: 'r', number: 7, actor: 'julian' }),
    )
    expect(calls).toEqual(['reset o/r#7 julian'])
  })

  it('falla claro si el runner no lleva topes', async () => {
    const desk = new TaskDesk()
    desk.connect({ redispatch: async () => '', rerunReview: async () => '', stop: () => '' })
    await expect(
      actionsFor(desk).resetRuns.run(ctxFor({ owner: 'o', repo: 'r', number: 7, actor: 'j' })),
    ).rejects.toThrow(/topes de corridas/)
  })
})
