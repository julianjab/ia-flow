import { createEvent } from '@ia-flow/agent-engine'
import { describe, expect, it } from 'vitest'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import { MemorySource, pipelineDoc } from './memory.js'

const agents = [
  {
    path: 'mem:agents/implementer',
    doc: { id: 'implementer', provider: 'fake', prompt: 'p' } as never,
  },
]

function source(maxRuns: Record<string, unknown>) {
  return new DefinitionPipelineSource(
    new MemorySource({
      id: 's',
      agents,
      pipelines: [
        pipelineDoc({ id: 'ci-red', on: ['check_suite'], do: [{ agent: 'implementer' }], maxRuns }),
      ],
    }),
    { functions: { notice: () => undefined } } as never,
  )
}

describe('maxRuns (YAML)', () => {
  it('arma el tope: contador, filtros, ventana y onExhausted', () => {
    const [pipeline] = source({
      max: 2,
      counter: 'ci-red',
      counts: [
        { on: ['check_suite'], when: [{ field: 'conclusion', op: 'eq', value: 'failure' }] },
      ],
      resetOn: [{ on: ['issue_comment'] }],
      window: '24h',
      onExhausted: [{ function: 'notice' }],
    }).list()
    const budget = pipeline?.maxRuns
    expect(budget?.max).toBe(2)
    expect(budget?.counter).toBe('ci-red')
    expect(budget?.windowMs).toBe(24 * 3_600_000)
    expect(budget?.onExhausted).toHaveLength(1)
    expect(budget?.counts(createEvent('check_suite', { conclusion: 'failure' }))).toBe(true)
    expect(budget?.counts(createEvent('check_suite', { conclusion: 'success' }))).toBe(false)
    expect(budget?.resets(createEvent('issue_comment', {}))).toBe(true)
  })

  it('sin `counter`, usa el id de la pipeline', () => {
    const [pipeline] = source({ max: 1, onExhausted: [{ function: 'notice' }] }).list()
    expect(pipeline?.maxRuns?.counter).toBe('ci-red')
  })

  it('onExhausted con un agente no carga', () => {
    expect(() => source({ max: 1, onExhausted: [{ agent: 'implementer' }] })).toThrow(
      /sólo lleva acciones/,
    )
  })
})
