import {
  Action,
  type Agent,
  createEvent,
  EventBus,
  type PauseAction,
  type Pipeline,
  ProviderRegistry,
  type ProviderRunContext,
} from '@ia-flow/agent-engine'
import type {
  ActionRequest,
  Catalogs,
  DefinitionPipelineSource,
} from '@ia-flow/agent-engine-definitions'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { sourceDir, yamlSource } from './fixtures.js'

class Named extends Action {
  readonly description: string
  readonly input = z.strictObject({ body: z.string().optional() })
  constructor(
    id: string,
    readonly request?: ActionRequest,
    override readonly sideEffects: 'none' | 'write' = 'write',
  ) {
    super({ id })
    this.description = id
  }
  execute(): string {
    return this.id
  }
}

/** Un provider que guarda con qué lo llamaron y elige `done`. */
function recording() {
  const runs: ProviderRunContext[] = []
  const providers = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      runs.push(ctx)
      await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
      return { outcome: 'done' }
    },
  })
  return { runs, providers }
}

const AGENT = `
id: writer
provider: fake
prompt: Escribí el PRD.
`

function load(files: Record<string, string>, catalogs: Catalogs): DefinitionPipelineSource {
  return yamlSource({ dir: sourceDir(files), catalogs })
}

const pipelineOf = (source: DefinitionPipelineSource, id = 'p') =>
  source.list().find((pipeline) => pipeline.id === id) as Pipeline

const run = (pipeline: Pipeline, payload: Record<string, unknown> = {}) =>
  pipeline.execute({
    event: createEvent('e', payload),
    steps: {},
    bus: new EventBus(),
    pipelineId: 'p',
  })

describe('YAML format extensions', () => {
  it('an ActionProvider is built per source and agent, with its options; an agent may take several', () => {
    const requests: ActionRequest[] = []
    const source = load(
      {
        'source.yaml': 'id: flow\n',
        'agents/writer.yaml': `${AGENT}actions:
  - { action: body, options: { write: [prd] } }
  - fixed
allowWrites: true
report: { action: comment }
`,
        'pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { agent: writer }\n',
      },
      {
        providers: recording().providers,
        actions: {
          fixed: new Named('fixed', undefined, 'none'),
          body: (request) => {
            requests.push(request)
            return [new Named('update_prd', request), new Named('check_prd', request)]
          },
          comment: (request) => new Named(`comment_by_${request.agentId}`, request),
        },
      },
    )
    const agent = pipelineOf(source).do[0] as Agent
    expect(agent.toolset.names).toEqual(['update_prd', 'check_prd', 'fixed'])
    expect(requests).toEqual([{ sourceId: 'flow', agentId: 'writer', options: { write: ['prd'] } }])
    expect(agent.definition.report?.id).toBe('comment_by_writer')
  })

  it('refuses options on a fixed action, and several actions where one step goes', () => {
    const catalogs = {
      actions: {
        fixed: new Named('fixed'),
        many: () => [new Named('a'), new Named('b')],
      },
    }
    expect(() =>
      load(
        { 'pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { action: fixed, options: { x: 1 } }\n' },
        catalogs,
      ),
    ).toThrow(/"fixed" es fija: no acepta `options`/)
    expect(() =>
      load({ 'pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { action: many }\n' }, catalogs),
    ).toThrow(/arma 2 acciones: como paso tiene que ser una sola/)
  })

  it('source system prompts go before each agent’s; inline input fields become its schema', async () => {
    const { runs, providers } = recording()
    const source = load(
      {
        'source.yaml': 'systemPrompts:\n  - text: Compartido.\n',
        'agents/writer.yaml': `${AGENT}systemPrompts:
  - text: Propio.
input:
  summary: { type: string, optional: true, description: Qué pidió }
  attempt: { type: number, optional: true }
`,
        'pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { agent: writer }\n',
      },
      { providers },
    )
    const agent = pipelineOf(source).do[0] as Agent
    expect(agent.acceptsInput()?.safeParse({ attempt: 1 }).success).toBe(true)
    expect(agent.acceptsInput()?.safeParse({ attempt: 'uno' }).success).toBe(false)
    expect(agent.acceptsInput()?.safeParse({ other: 1 }).success).toBe(false)
    await run(pipelineOf(source))
    expect(runs[0]?.systemPrompts).toEqual(['Compartido.', 'Propio.'])
  })

  it('MCP servers by id come from the catalog; a missing one is skipped with a warning', () => {
    const source = load(
      {
        'agents/writer.yaml': `${AGENT}mcpServers: [github, figma, { id: inline, config: { url: x } }]\n`,
        'pipelines/p.yaml': 'id: p\non: [e]\ndo:\n  - { agent: writer }\n',
      },
      { mcpServers: { github: { id: 'github', config: { url: 'https://mcp' } } } },
    )
    const agent = pipelineOf(source).do[0] as Agent
    expect(agent.definition.mcpServers?.map((server) => server.id)).toEqual(['github', 'inline'])
  })

  it('a brief or when on an agent step makes an instance of its own; without them it is shared', async () => {
    const { runs, providers } = recording()
    const source = load(
      {
        'agents/writer.yaml': AGENT,
        'pipelines/p.yaml': `id: p
on: [e]
do:
  - agent: writer
    brief: "## Por qué estás corriendo\\n\\nLlegó a Refine."
    when: [{ field: type, op: eq, value: technical }]
`,
        'pipelines/q.yaml': 'id: q\non: [e]\ndo:\n  - { agent: writer }\n',
        'pipelines/r.yaml': 'id: r\non: [e]\ndo:\n  - { agent: writer }\n',
      },
      { providers },
    )
    const briefed = pipelineOf(source, 'p').do[0]
    expect(briefed).not.toBe(pipelineOf(source, 'q').do[0])
    expect(pipelineOf(source, 'q').do[0]).toBe(pipelineOf(source, 'r').do[0])

    await run(pipelineOf(source, 'p'), { type: 'functional' })
    expect(runs).toEqual([])
    await run(pipelineOf(source, 'p'), { type: 'technical' })
    expect(runs[0]?.prompt).toBe('## Por qué estás corriendo\n\nLlegó a Refine.\n\nEscribí el PRD.')
  })

  it('a pause timeout takes a duration', () => {
    const source = load(
      {
        'pipelines/p.yaml':
          'id: p\non: [e]\ndo:\n  - { pause: wait, branches: { go: { on: [go] } }, timeout: { after: 30m } }\n',
      },
      {},
    )
    expect((pipelineOf(source).do[0] as PauseAction).timeout?.afterMs).toBe(30 * 60_000)
    expect(() =>
      load(
        {
          'pipelines/p.yaml':
            'id: p\non: [e]\ndo:\n  - { pause: wait, timeout: { after: 30m, afterMs: 5 } }\n',
        },
        {},
      ),
    ).toThrow(/`after` o `afterMs`/)
  })
})
