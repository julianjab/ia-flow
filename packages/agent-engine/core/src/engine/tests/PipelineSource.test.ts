import { describe, expect, it } from 'vitest'
import { Pipeline } from '../../pipeline/Pipeline.js'
import { StaticPipelineSource } from '../PipelineSource.js'

describe('StaticPipelineSource', () => {
  it('list returns exactly the pipelines passed to the constructor', () => {
    const p1 = new Pipeline({ id: 'p1', on: ['a'], do: [] })
    const p2 = new Pipeline({ id: 'p2', on: ['b'], do: [] })

    const source = new StaticPipelineSource([p1, p2])

    expect(source.list()).toEqual([p1, p2])
  })

  it('list on an empty source returns an empty array', () => {
    const source = new StaticPipelineSource([])
    expect(source.list()).toEqual([])
  })
})
