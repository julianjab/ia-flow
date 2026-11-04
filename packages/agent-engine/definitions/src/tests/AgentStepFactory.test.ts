import { Action, createEvent, EventBus, ProviderRegistry } from '@ia-flow/agent-engine'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DefinitionPipelineSource } from '../DefinitionSource.js'
import { MemorySource, pipelineDoc } from './memory.js'

/** Una acción que anota en `log` cada vez que corre. */
function recorder(id: string, log: string[], sideEffects: 'none' | 'write' = 'none') {
  const input = z.object({}).passthrough()
  return new (class extends Action<typeof input> {
    readonly description = id
    readonly input = input
    override readonly sideEffects = sideEffects
    execute() {
      log.push(id)
      return id
    }
  })({ id })
}

/** El reviewer como en un deploy: con su reporte y una tool que escribe en el PR. El paso del
 *  gate lo puede dejar mudo. */
function gate(step: Record<string, unknown>) {
  const log: string[] = []
  const tools: string[] = []
  const providers = new ProviderRegistry().register({
    id: 'fake',
    run: async (ctx) => {
      tools.push(...ctx.tools.map((tool) => tool.name))
      await ctx.tools.find((tool) => tool.name === 'submit_approved')?.handler({})
      return { outcome: 'success' }
    },
  })
  const source = new DefinitionPipelineSource(
    new MemorySource({
      id: 's',
      agents: [
        {
          path: 'mem:agents/reviewer',
          doc: {
            id: 'reviewer',
            provider: 'fake',
            prompt: 'p',
            allowWrites: true,
            actions: ['review_pull_request', 'pr_checks'],
            report: { action: 'post_comment' },
            routes: { approved: { to: { action: 'mark' } } },
          } as never,
        },
      ],
      pipelines: [
        pipelineDoc({ id: 'review', on: ['review'], do: [{ agent: 'reviewer', ...step }] }),
      ],
    }),
    {
      providers,
      actions: {
        review_pull_request: recorder('review_pull_request', log, 'write'),
        pr_checks: recorder('pr_checks', log),
        post_comment: recorder('post_comment', log),
        mark: recorder('mark', log),
      },
    } as never,
  )
  const run = async () => {
    const [pipeline] = source.list()
    await pipeline?.execute({
      event: createEvent('review', {}),
      steps: {},
      bus: new EventBus(),
      pipelineId: 'review',
    })
  }
  return { log, tools, run }
}

describe('agent (YAML): un paso que ajusta al agente', () => {
  it('sin ajustes, el agente recibe sus actions y el engine publica su reporte', async () => {
    const { log, tools, run } = gate({})
    await run()
    expect(tools).toEqual(expect.arrayContaining(['review_pull_request', 'pr_checks']))
    expect(log).toEqual(['post_comment', 'mark'])
  })

  it('`report: null` + `withoutActions`: corre y vota, pero no escribe en el PR ni publica su cierre', async () => {
    const { log, tools, run } = gate({ report: null, withoutActions: ['review_pull_request'] })
    await run()
    expect(tools).toContain('pr_checks')
    expect(tools).not.toContain('review_pull_request')
    expect(log).toEqual(['mark'])
  })

  it('`withoutActions` con una action que el agente no tiene no carga', () => {
    expect(() => gate({ withoutActions: ['merge_pull_request'] })).toThrow(
      /withoutActions nombra merge_pull_request, que no son actions del agente reviewer/,
    )
  })
})
