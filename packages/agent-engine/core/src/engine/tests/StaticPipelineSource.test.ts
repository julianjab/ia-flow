import { describe, expect, it } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import type { PipelineExecutionContext } from '../../pipeline/Runnable.js'
import { Engine } from '../Engine.js'
import { type PipelineSource, StaticPipelineSource } from '../PipelineSource.js'

describe('StaticPipelineSource', () => {
  it('lists its pipelines and exposes its id and its onError/report as defaults', () => {
    const report = new FunctionAction({ id: 'report', fn: () => null })
    const onError = { to: new FunctionAction({ id: 'blocked', fn: () => null }) }
    const pipeline = new Pipeline({ id: 'p', on: ['a'], do: [] })

    const source = new StaticPipelineSource([pipeline], {
      id: 'lahaus',
      defaults: { report, onError },
    })

    expect(source.list()).toEqual([pipeline])
    expect(source.id).toBe('lahaus')
    expect(source.defaults).toEqual({ report, onError })
    expect(new StaticPipelineSource([pipeline]).defaults).toBeUndefined()
  })

  it('rejects two pipelines with the same id', () => {
    const one = new Pipeline({ id: 'p', on: ['a'], do: [] })
    const two = new Pipeline({ id: 'p', on: ['b'], do: [] })

    expect(() => new StaticPipelineSource([one, two], { id: 'lahaus' })).toThrow(
      /lahaus: dos pipelines con el id "p"/,
    )
  })

  it('the Engine passes the source defaults into every pipeline run', async () => {
    const report = new FunctionAction({ id: 'report', fn: () => null })
    let seen: PipelineExecutionContext['defaults']
    const pipeline = new Pipeline({
      id: 'p',
      on: ['a'],
      do: [
        new FunctionAction({
          fn: (ctx) => {
            seen = ctx.defaults
          },
        }),
      ],
    })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new StaticPipelineSource([pipeline], { id: 'lahaus', defaults: { report } }),
    })

    await engine.dispatch(createEvent('a', {}))

    expect(seen).toEqual({ report })
  })

  it('with several sources, each runs its pipelines with its own defaults', async () => {
    const localReport = new FunctionAction({ id: 'local-report', fn: () => null })
    const ran: Array<[string, unknown]> = []
    const pipeline = (id: string) =>
      new Pipeline({
        id,
        on: ['a'],
        do: [new FunctionAction({ fn: (ctx) => void ran.push([id, ctx.defaults?.report]) })],
      })
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: [
        new StaticPipelineSource([pipeline('prod-refine')], { id: 'prod' }),
        new StaticPipelineSource([pipeline('local-refine')], {
          id: 'local',
          defaults: { report: localReport },
        }),
      ],
    })

    await engine.dispatch(createEvent('a', {}))

    expect(ran.sort()).toEqual([
      ['local-refine', localReport],
      ['prod-refine', undefined],
    ])
  })

  it('a source of its own can still filter all its pipelines (explainMismatch)', async () => {
    const ran: string[] = []
    const source: PipelineSource = {
      id: 'blocked-only',
      list: () => [
        new Pipeline({
          id: 'p',
          on: ['a'],
          do: [new FunctionAction({ fn: () => void ran.push('p') })],
        }),
      ],
      explainMismatch: (event) =>
        (event.payload as { blocked?: boolean }).blocked ? undefined : 'no está bloqueada',
    }
    const engine = new Engine({ bus: new EventBus(), pipelines: source })

    expect(await engine.dispatch(createEvent('a', { blocked: false }))).toBe('skipped')
    await engine.dispatch(createEvent('a', { blocked: true }))
    expect(ran).toEqual(['p'])
  })
})
