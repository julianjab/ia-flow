import { describe, expect, it } from 'vitest'
import { Agent } from '../../agent/Agent.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { Condition } from '../../condition/Condition.js'
import { createEvent, type DomainEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline, type PipelineProps } from '../../pipeline/Pipeline.js'
import { Engine } from '../Engine.js'
import { InMemoryExecutionStore } from '../InMemoryExecutionStore.js'
import { StaticPipelineSource } from '../PipelineSource.js'

const TASK = { projectId: 'p', repo: 'la-haus/subscriptions', issue: 1700 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK })

/** El rebote del reviewer: la card vuelve a Build movida por el bot. */
const bounce = () =>
  event('status_changed', { to: 'Build', from: 'Review', sender: 'ia-flow[bot]' })
/** Una persona mueve la card. */
const humanMove = () => event('status_changed', { to: 'Build', from: 'Review', sender: 'julian' })

function rebuild(log: string[], maxRuns: Partial<NonNullable<PipelineProps['maxRuns']>> = {}) {
  const implementer = new Agent(
    { id: 'implementer', provider: 'fake', prompt: 'p' },
    new ProviderRegistry().register({
      id: 'fake',
      run: async () => {
        log.push('implementer')
        return { outcome: 'success' }
      },
    }),
  )
  return new Pipeline({
    id: 'build-reentry',
    on: ['status_changed'],
    do: [implementer],
    maxRuns: {
      max: 2,
      counter: 'review-loop',
      counts: [
        {
          on: ['status_changed'],
          when: [new Condition({ field: 'sender', op: 'matches', value: '\\[bot\\]$' })],
        },
      ],
      resetOn: [{ on: ['issue_comment'] }],
      onExhausted: [new FunctionAction({ id: 'blocked', fn: () => log.push('blocked') })],
      ...maxRuns,
    },
  })
}

function engineWith(pipelines: Pipeline[]) {
  return new Engine({
    bus: new EventBus(),
    pipelines: new StaticPipelineSource(pipelines),
    executions: new InMemoryExecutionStore(),
  })
}

describe('Engine — maxRuns', () => {
  it('corre hasta el tope; pasado, corre onExhausted en vez de la pipeline', async () => {
    const log: string[] = []
    const engine = engineWith([rebuild(log)])
    await engine.dispatch(bounce())
    await engine.dispatch(bounce())
    await engine.dispatch(bounce())
    expect(log).toEqual(['implementer', 'implementer', 'blocked'])
  })

  it('lo que hace una persona no cuenta (`counts`)', async () => {
    const log: string[] = []
    const engine = engineWith([rebuild(log)])
    await engine.dispatch(bounce())
    await engine.dispatch(humanMove())
    await engine.dispatch(humanMove())
    await engine.dispatch(bounce())
    expect(log).toEqual(['implementer', 'implementer', 'implementer', 'implementer'])
  })

  it('un evento de `resetOn` pone la cuenta en cero, aunque su pipeline no corra por él', async () => {
    const log: string[] = []
    const engine = engineWith([rebuild(log)])
    await engine.dispatch(bounce())
    await engine.dispatch(bounce())
    await engine.dispatch(event('issue_comment', { body: 'probá otra cosa' }))
    await engine.dispatch(bounce())
    expect(log).toEqual(['implementer', 'implementer', 'implementer'])
  })

  it('cada task tiene su cuenta', async () => {
    const log: string[] = []
    const engine = engineWith([rebuild(log, { max: 1 })])
    const other = createEvent(
      'status_changed',
      { to: 'Build', from: 'Review', sender: 'ia-flow[bot]' },
      { scope: { ...TASK, issue: 1701 } },
    )
    await engine.dispatch(bounce())
    await engine.dispatch(other)
    await engine.dispatch(bounce())
    expect(log).toEqual(['implementer', 'implementer', 'blocked'])
  })

  it('onExhausted sólo lleva acciones', () => {
    const agent = new Agent({ id: 'a', provider: 'fake', prompt: 'p' })
    expect(
      () =>
        new Pipeline({
          id: 'p',
          on: ['e'],
          do: [agent],
          maxRuns: { max: 1, onExhausted: [agent] },
        }),
    ).toThrow('sólo lleva acciones')
  })
})
