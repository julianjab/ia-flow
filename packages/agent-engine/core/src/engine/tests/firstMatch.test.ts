import { describe, expect, it } from 'vitest'
import { Condition } from '../../condition/Condition.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { PauseAction } from '../../pipeline/actions/PauseAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { Engine } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'

const TASK = { projectId: 'p', issue: 7 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK })
const repo = (value: string) => [new Condition({ field: 'repo', op: 'eq', value })]

describe('Pipeline firstMatch', () => {
  it('runs only the first step whose when passes', async () => {
    const ran: string[] = []
    const alt = (id: string, value: string) =>
      new FunctionAction({ id, when: repo(value), fn: () => void ran.push(id) })
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      firstMatch: true,
      do: [alt('frontend', 'front'), alt('any-1', 'back'), alt('any-2', 'back')],
    })
    const engine = new Engine({ bus: new EventBus(), pipelines: [{ list: () => [pipeline] }] })

    await engine.dispatch(event('a', { repo: 'back' }))
    await engine.dispatch(event('a', { repo: 'front' }))

    expect(ran).toEqual(['any-1', 'frontend'])
  })

  it('a paused alternative does not go on to the next ones when it resumes', async () => {
    const ran: string[] = []
    const waitCi = new PauseAction({
      id: 'wait-ci',
      branches: {
        green: {
          on: ['check_suite'],
          to: new FunctionAction({ id: 'review', fn: () => void ran.push('review') }),
        },
      },
    })
    const pipeline = new Pipeline({
      id: 'build',
      on: ['build'],
      firstMatch: true,
      do: [
        new FunctionAction({
          id: 'frontend',
          when: repo('front'),
          fn: () => void ran.push('frontend'),
        }),
        waitCi,
        // Sin `firstMatch` esto correría al reanudar: su `when` también pasa con el evento del CI.
        new FunctionAction({ id: 'generic', fn: () => void ran.push('generic') }),
      ],
    })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: [{ list: () => [pipeline] }],
      executions: new InMemoryExecutionStore(),
    })

    await engine.dispatch(event('build', { repo: 'back' }))
    await engine.dispatch(event('check_suite', { repo: 'back' }))

    expect(ran).toEqual(['review'])
  })
})
