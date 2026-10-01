import { createEvent, EventBus } from '@ia-flow/agent-engine'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import { MemorySource, pipelineDoc } from './memory.js'

const source = (step: Record<string, unknown>) =>
  new DefinitionPipelineSource(
    new MemorySource({
      id: 's',
      agents: [],
      pipelines: [pipelineDoc({ id: 'p', on: ['e'], do: [step] })],
    }),
  )

describe('http without connection', () => {
  afterEach(() => vi.restoreAllMocks())

  it('the host is written by the definition: a template before it does not load', () => {
    for (const http of ['{{url}}', 'https://{{host}}/x', 'https://api.test{{path}}']) {
      expect(() => source({ http })).toThrow(/sin `connection` el host va escrito/)
    }
  })

  it('an event value cannot change the host: it is encoded, and the origin is checked', async () => {
    const requested: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requested.push(String(input))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    })
    const [pipeline] = source({
      http: 'https://api.test/items/{{path}}',
      headers: { authorization: 'secreto' },
    }).list()
    await pipeline?.execute({
      event: createEvent('e', { path: '@evil.com/x?y#z' }),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'p',
    })
    expect(requested).toEqual(['https://api.test/items/%40evil.com%2Fx%3Fy%23z'])
  })

  it('a fixed URL, without templates, goes as written', async () => {
    const requested: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requested.push(String(input))
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    })
    for (const http of ['https://api.test', 'https://api.test/']) {
      const [pipeline] = source({ http }).list()
      await pipeline?.execute({
        event: createEvent('e', {}),
        steps: {},
        bus: new EventBus(),
        pipelineId: 'p',
      })
    }
    expect(requested).toEqual(['https://api.test/', 'https://api.test/'])
  })
})
