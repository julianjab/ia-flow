import { describe, expect, it } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { DispatchPlanner } from '../DispatchPlanner.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const noop = () => new FunctionAction({ fn: () => undefined })
const pipeline = (id: string, extra: Partial<ConstructorParameters<typeof Pipeline>[0]> = {}) =>
  new Pipeline({ id, on: ['build'], do: [noop()], ...extra })

describe('DispatchPlanner', () => {
  it('keeps every candidate with the reason it does not run', async () => {
    const planner = new DispatchPlanner([
      new StaticPipelineSource([pipeline('a'), pipeline('off', { enabled: false })]),
    ])
    const plan = await planner.plan(createEvent('build', {}))
    expect(plan.toRun.map(({ pipeline }) => pipeline.id)).toEqual(['a'])
    expect(plan.candidates.find(({ pipeline }) => pipeline.id === 'off')?.mismatch).toBe(
      'deshabilitada',
    )
  })

  it('an exclusive match blocks lower priorities but not higher ones', async () => {
    const planner = new DispatchPlanner([
      new StaticPipelineSource([
        pipeline('first', { position: 0 }),
        pipeline('exclusive', { position: 1, exclusive: true }),
        pipeline('later', { position: 2 }),
      ]),
    ])
    const plan = await planner.plan(createEvent('build', {}))
    expect(plan.winningExclusive?.id).toBe('exclusive')
    expect((await planner.select(createEvent('build', {}))).map(({ id }) => id)).toEqual([
      'first',
      'exclusive',
    ])
  })

  it('finds the pipeline of a checkpoint in its own source, and refuses an ambiguous one', async () => {
    const a = { id: 'a', list: () => [pipeline('build')] }
    const b = { id: 'b', list: () => [pipeline('build')] }
    const planner = new DispatchPlanner([a, b])
    const checkpoint = { pipelineId: 'build', pauseId: 'p', resumeAt: 0, steps: {}, shape: '' }

    expect((await planner.findCandidate({ ...checkpoint, sourceId: 'b' })).source).toBe(b)
    await expect(planner.findCandidate(checkpoint)).rejects.toThrow(/2 pipelines "build"/)
    await expect(planner.findCandidate({ ...checkpoint, pipelineId: 'x' })).rejects.toThrow(
      /no hay una pipeline "x"/,
    )
  })
})
