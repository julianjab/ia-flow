import { createEvent, EventBus, type GroupResult, ProviderRegistry } from '@ia-flow/agent-engine'
import { describe, expect, it } from 'vitest'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import { MemorySource, pipelineDoc } from './memory.js'

/** Cada agente elige la salida que dice `choices`. */
function providers(choices: Record<string, string>) {
  return new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      await ctx.tools.find((tool) => tool.name === `submit_${choices[ctx.agentId]}`)?.handler({})
      return { outcome: 'success' }
    },
  })
}

const agentDoc = (id: string, routes: Record<string, unknown>) => ({
  path: `mem:agents/${id}`,
  doc: { id, provider: 'fake', prompt: 'p', routes } as never,
})

/** El gate de Review como se escribe en un deploy: reviewer y e2e a la vez, y el grupo decide. */
function reviewSource(
  choices: Record<string, string>,
  log: string[],
  group: Record<string, unknown> = {},
) {
  return new DefinitionPipelineSource(
    new MemorySource({
      id: 's',
      agents: [
        // El reviewer trae destinos propios: en el grupo no corren.
        agentDoc('reviewer', {
          approved: { to: { function: 'reviewer-own' } },
          back_to_build: { to: { function: 'reviewer-own' } },
        }),
        agentDoc('e2e', { passed: {}, back_to_build: {} }),
      ],
      pipelines: [
        pipelineDoc({
          id: 'review',
          on: ['review'],
          do: [
            {
              parallel: [
                { agent: 'reviewer', brief: 'revisá el diff' },
                {
                  agent: 'e2e',
                  when: [{ field: 'repo', op: 'eq', value: 'frontend' }],
                },
              ],
              id: 'gate',
              until: { all: ['approved', 'passed'] },
              routes: {
                passed: { to: { function: 'slack-review' } },
                failed: { to: { function: 'to-build' } },
              },
              ...group,
            },
          ],
        }),
      ],
    }),
    {
      providers: providers(choices),
      functions: {
        'reviewer-own': () => log.push('reviewer-own'),
        'slack-review': () => log.push('slack-review'),
        'to-build': () => log.push('to-build'),
      },
    } as never,
  )
}

async function run(source: DefinitionPipelineSource, payload: Record<string, unknown>) {
  const [pipeline] = source.list()
  return pipeline?.execute({
    event: createEvent('review', payload),
    steps: {},
    bus: new EventBus(),
    pipelineId: 'review',
  })
}

describe('parallel (YAML)', () => {
  it('arma el grupo: los dos aprueban → `passed`, y los destinos propios del reviewer no corren', async () => {
    const log: string[] = []
    const source = reviewSource({ reviewer: 'approved', e2e: 'passed' }, log)
    const steps = await run(source, { repo: 'frontend' })
    expect(log).toEqual(['slack-review'])
    expect((steps?.gate as GroupResult | undefined)?.passed).toBe(true)
  })

  it('uno no aprueba → `failed`', async () => {
    const log: string[] = []
    const source = reviewSource({ reviewer: 'approved', e2e: 'back_to_build' }, log)
    await run(source, { repo: 'frontend' })
    expect(log).toEqual(['to-build'])
  })

  it('un miembro que su `when` saltea no cuenta (el backend no tiene e2e visual)', async () => {
    const log: string[] = []
    const source = reviewSource({ reviewer: 'approved', e2e: 'back_to_build' }, log)
    await run(source, { repo: 'backend' })
    expect(log).toEqual(['slack-review'])
  })

  it('`advisory`: el e2e consultivo no traba el gate', async () => {
    const log: string[] = []
    const source = reviewSource({ reviewer: 'approved', e2e: 'back_to_build' }, log, {
      until: { all: 'approved' },
      advisory: ['e2e'],
    })
    await run(source, { repo: 'frontend' })
    expect(log).toEqual(['slack-review'])
  })

  it('un grupo sin `id` no carga', () => {
    const broken = new MemorySource({
      id: 's',
      agents: [agentDoc('a', { ok: {} }), agentDoc('b', { ok: {} })],
      pipelines: [
        pipelineDoc({
          id: 'p',
          on: ['e'],
          do: [{ parallel: [{ agent: 'a' }, { agent: 'b' }], until: { all: 'ok' } }],
        }),
      ],
    })
    expect(() => new DefinitionPipelineSource(broken)).toThrow(/parallel inválido/)
  })
})
