import { createEvent, Engine, EventBus, ProviderRegistry } from '@ia-flow/agent-engine'
import { pipelineSourceContract } from '@ia-flow/agent-engine/testing'
import { describe, expect, it } from 'vitest'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import { MemorySource, pipelineDoc } from './memory.js'

const emitting = (id: string, extra: Record<string, unknown> = {}) =>
  pipelineDoc({ id, on: ['build'], do: [{ emit: 'built' }], ...extra })

pipelineSourceContract('DefinitionPipelineSource', () => ({
  source: new DefinitionPipelineSource(
    new MemorySource({ id: 's', agents: [], pipelines: [emitting('build')] }),
  ),
  matching: createEvent('build', {}),
  expected: ['build'],
  nonMatching: createEvent('nobody-listens', {}),
}))

describe('DefinitionPipelineSource', () => {
  it('builds whatever a datasource gives: its id is the datasource’s', () => {
    const built = new DefinitionPipelineSource(
      new MemorySource({ id: 'mem', agents: [], pipelines: [emitting('a')] }),
    )
    expect(built.id).toBe('mem')
    expect(built.list().map((p) => p.id)).toEqual(['a'])
  })

  it('a pipeline scope is a property like any other: the engine filters by it', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: new DefinitionPipelineSource(
        new MemorySource({
          id: 's',
          agents: [],
          pipelines: [emitting('a', { scope: { projectId: 'x' } })],
        }),
      ),
    })
    const selected = async (projectId: string) =>
      (await engine.select(createEvent('build', {}, { scope: { projectId } }))).map((p) => p.id)
    expect(await selected('x')).toEqual(['a'])
    expect(await selected('y')).toEqual([])
  })

  it('rebuilds when the version changes, and keeps the last good one when the new one is broken', () => {
    const datasource = new MemorySource({ id: 's', agents: [], pipelines: [emitting('a')] })
    const built = new DefinitionPipelineSource(datasource)

    datasource.set({ pipelines: [emitting('a'), emitting('b')] })
    expect(built.list().map((p) => p.id)).toEqual(['a', 'b'])

    datasource.set({ pipelines: [pipelineDoc({ id: 'c', on: ['build'], do: [{ nope: 1 }] })] })
    expect(built.list().map((p) => p.id)).toEqual(['a', 'b'])
  })

  it('the first load throws: without a good version there is nothing to dispatch', () => {
    const broken = new MemorySource({
      id: 's',
      agents: [],
      pipelines: [pipelineDoc({ id: 'c', on: ['build'], do: [{ nope: 1 }] })],
    })
    expect(() => new DefinitionPipelineSource(broken)).toThrow(/mem:pipelines\/c/)
  })

  it('builds the capabilities of the source like any step, and the engine asks them', async () => {
    const providers = new ProviderRegistry().register({
      id: 'fake',
      run: async (ctx) => {
        const criterion = (ctx.ctx.event.payload as { criterion: string }).criterion
        await ctx.tools
          .find((tool) => tool.name === 'submit_done')
          ?.handler({ result: { matches: criterion === 'yes', reason: ctx.prompt } })
        return { outcome: 'success' }
      },
    })
    const source = new DefinitionPipelineSource(
      new MemorySource({
        id: 's',
        source: {
          path: 'mem:source',
          doc: { capabilities: { whenText: { agent: 'classifier' } } },
        },
        agents: [
          {
            path: 'mem:agents/classifier',
            doc: { id: 'classifier', provider: 'fake', prompt: 'criterio: {{criterion}}' } as never,
          },
        ],
        pipelines: ['yes', 'no'].map((id) => emitting(id, { whenText: id })),
      }),
      { providers },
    )
    expect(Object.keys(source.capabilities)).toEqual(['whenText'])

    const engine = new Engine({
      bus: new EventBus(),
      pipelines: source,
      capabilities: (name) => source.capabilities[name],
    })
    expect((await engine.select(createEvent('build', {}))).map((p) => p.id)).toEqual(['yes'])
  })
})
