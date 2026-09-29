import { describe, expect, it } from 'bun:test'
import {
  createEvent,
  Engine,
  EventBus,
  FunctionAction,
  Pipeline,
  StaticPipelineSource,
} from '@ia-tools/agent-engine'
import { ProjectSource } from '../projects/ProjectSource.js'

const pipeline = (id: string) =>
  new Pipeline({
    id,
    on: ['issue.created'],
    do: [new FunctionAction({ id: `${id}-step`, fn: () => {} })],
  })

const event = (projectId?: string) =>
  createEvent('issue.created', {}, projectId ? { scope: { projectId } } : {})

describe('ProjectSource', () => {
  const source = new ProjectSource(new StaticPipelineSource([pipeline('refine')], { id: 'a' }), 'a')

  it('only takes the events of its project', () => {
    expect(source.explainMismatch(event('a'))).toBeUndefined()
    expect(source.explainMismatch(event('b'))).toBe('proyecto a: el evento es del proyecto b')
    expect(source.explainMismatch(event())).toBe('proyecto a: el evento no es de ningún proyecto')
  })

  it('next to a global source, the engine gives each event to the right one', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: [
        new StaticPipelineSource([pipeline('intake')], { id: 'runner' }),
        source,
        new ProjectSource(new StaticPipelineSource([pipeline('other')], { id: 'b' }), 'b'),
      ],
    })
    const selected = async (projectId?: string) =>
      (await engine.select(event(projectId))).map((p) => p.id).sort()
    expect(await selected('a')).toEqual(['intake', 'refine'])
    expect(await selected('b')).toEqual(['intake', 'other'])
    expect(await selected()).toEqual(['intake'])
  })
})
