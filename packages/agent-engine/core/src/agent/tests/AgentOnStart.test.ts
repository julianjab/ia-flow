import { describe, expect, it } from 'vitest'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Agent } from '../Agent.js'
import { ProviderRegistry } from '../Provider.js'

const ctx = (payload: Record<string, unknown> = {}) => ({
  event: createEvent('e', payload),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'p',
})

function agentWith(onStart: FunctionAction[], ran: string[]) {
  return new Agent(
    { id: 'implementer', provider: 'done', prompt: 'p', onStart },
    new ProviderRegistry().register({
      id: 'done',
      run: async () => {
        ran.push('provider')
        return { outcome: 'done' }
      },
    }),
  )
}

describe('Agent onStart inside a pipeline', () => {
  it('runs each step as a pipeline step: its when decides and its output lands in steps', async () => {
    const ran: string[] = []
    const agent = agentWith(
      [
        new FunctionAction({ id: 'unlabel', fn: () => ran.push('unlabel') }),
        new FunctionAction({
          id: 'only-bugs',
          when: [new Condition({ field: 'type', op: 'eq', value: 'bug' })],
          fn: () => ran.push('only-bugs'),
        }),
      ],
      ran,
    )
    const steps = await new Pipeline({ id: 'p', on: ['e'], do: [agent] }).execute(
      ctx({ type: 'feature' }),
    )
    expect(ran).toEqual(['unlabel', 'provider'])
    expect(steps.unlabel).toBe(1)
  })

  it('a step that throws stops the agent, even if the pipeline has its own onError', async () => {
    const ran: string[] = []
    const agent = agentWith(
      [
        new FunctionAction({
          id: 'link-branch',
          fn: () => {
            throw new Error('sin rama')
          },
        }),
      ],
      ran,
    )
    const pipeline = new Pipeline({
      id: 'p',
      on: ['e'],
      do: [agent],
      // Sólo cubre al agente (su cascada): el paso de onStart no lo aplica y el error sube.
      onError: { to: new FunctionAction({ id: 'blocked', fn: () => ran.push('blocked') }) },
    })
    await pipeline.execute(ctx())
    expect(ran).toEqual(['blocked'])
  })
})
