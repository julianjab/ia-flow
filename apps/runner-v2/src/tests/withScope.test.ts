import { describe, expect, it } from 'bun:test'
import { createEvent, Engine, EventBus } from '@ia-flow/agent-engine'
import {
  DefinitionPipelineSource,
  type DefinitionSource,
  type SourceDocs,
} from '@ia-flow/agent-engine-definitions'
import { withScope } from '../projects/withScope.js'

/** Un datasource en memoria con una pipeline por id. */
const memory = (id: string, pipelines: string[]): DefinitionSource => ({
  version: () => '1',
  read: (): SourceDocs => ({
    id,
    source: { path: `mem:${id}`, doc: {} },
    agents: [],
    pipelines: pipelines.map((p) => ({
      path: `mem:${id}/${p}`,
      doc: { id: p, on: ['issue.created'], do: [{ emit: 'x' }] } as never,
    })),
  }),
})

const event = (projectId?: string) =>
  createEvent('issue.created', {}, projectId ? { scope: { projectId } } : {})

describe('withScope', () => {
  it('puts the project scope on every pipeline of the source, keeping what it had', () => {
    const scoped = withScope(memory('a', ['refine']), { projectId: 'a' }).read()
    expect(scoped.pipelines.map((p) => p.doc.scope)).toEqual([{ projectId: 'a' }])
  })

  it('next to the global source, the engine gives each event to its project', async () => {
    const engine = new Engine({
      bus: new EventBus(),
      pipelines: [
        new DefinitionPipelineSource(memory('runner', ['intake'])),
        new DefinitionPipelineSource(withScope(memory('a', ['refine']), { projectId: 'a' })),
        new DefinitionPipelineSource(withScope(memory('b', ['other']), { projectId: 'b' })),
      ],
    })
    const selected = async (projectId?: string) =>
      (await engine.select(event(projectId))).map((p) => p.id).sort()
    expect(await selected('a')).toEqual(['intake', 'refine'])
    expect(await selected('b')).toEqual(['intake', 'other'])
    expect(await selected()).toEqual(['intake'])
  })
})
