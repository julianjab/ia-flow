import { describe, expect, it } from 'vitest'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import { PipelineDoc } from '../schema.js'
import { MemorySource, pipelineDoc } from './memory.js'

const agents = [
  {
    path: 'mem:agents/implementer',
    doc: { id: 'implementer', provider: 'fake', prompt: 'p' } as never,
  },
]

function source(extra: Record<string, unknown>) {
  return new DefinitionPipelineSource(
    new MemorySource({
      id: 's',
      agents,
      pipelines: [
        pipelineDoc({
          id: 'build-reentry',
          on: ['status_changed'],
          do: [{ agent: 'implementer' }],
          ...extra,
        }),
      ],
    }),
    {} as never,
  )
}

describe('supersedes (YAML)', () => {
  it('pasa las pipelines que deja sin efecto', () => {
    const [pipeline] = source({ supersedes: ['pr-conflict'] }).list()
    expect(pipeline?.supersedes).toEqual(['pr-conflict'])
  })

  it('sin `supersedes`, ninguna', () => {
    const [pipeline] = source({}).list()
    expect(pipeline?.supersedes).toEqual([])
  })

  it('el schema rechaza una lista vacía: no deja nada sin efecto', () => {
    const doc = { id: 'x', on: ['e'], do: [{ agent: 'implementer' }] }
    expect(PipelineDoc.safeParse({ ...doc, supersedes: [] }).success).toBe(false)
    expect(PipelineDoc.safeParse({ ...doc, supersedes: ['pr-conflict'] }).success).toBe(true)
  })
})
