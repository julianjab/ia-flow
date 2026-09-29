import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent } from '../../agent/Agent.js'
import type { Provider, ProviderRunContext } from '../../agent/Provider.js'
import { ProviderRegistry } from '../../agent/Provider.js'
import { EventBus } from '../../events/EventBus.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { END } from '../../routing/ExitRoutes.js'
import { Capabilities } from '../Capabilities.js'
import { defineCapability } from '../Capability.js'

const SUMMARY = defineCapability({
  name: 'summary',
  description: 'Resume un texto.',
  input: z.strictObject({ text: z.string() }),
  output: z.strictObject({ summary: z.string() }),
})

const bus = new EventBus()

/** Un agente cuyo provider llama `tool` con `input` y guarda lo que vio. */
function agentCalling(
  tool: string,
  input: unknown,
  seen: ProviderRunContext[] = [],
  routes?: Agent['definition']['routes'],
): Agent {
  const run: Provider['run'] = async (ctx) => {
    seen.push(ctx)
    await ctx.tools.find((candidate) => candidate.name === tool)?.handler(input)
    return { outcome: 'success' }
  }
  return new Agent(
    {
      id: 'summarizer',
      provider: 'fake',
      prompt: 'Resumí: {{text}}',
      ...(routes ? { routes } : {}),
    },
    new ProviderRegistry().register({ id: 'fake', run }),
  )
}

describe('Capabilities', () => {
  it('without anyone bound, the capability is off', async () => {
    const capabilities = new Capabilities({}, bus)
    expect(capabilities.has('summary')).toBe(false)
    expect(await capabilities.invoke(SUMMARY, { text: 'x' })).toBeUndefined()
  })

  it('a plain step gets the input as payload and as input, and its output is validated', async () => {
    const seen: unknown[] = []
    const capabilities = new Capabilities(
      {
        summary: new FunctionAction({
          input: SUMMARY.input,
          fn: (ctx, input) => {
            seen.push(ctx.event.type, ctx.event.payload, input)
            return { summary: 'corto' }
          },
        }),
      },
      bus,
    )

    expect(await capabilities.invoke(SUMMARY, { text: 'largo' })).toEqual({ summary: 'corto' })
    expect(seen).toEqual(['capability.summary', { text: 'largo' }, { text: 'largo' }])
  })

  it('rejects an input or an output off-contract', async () => {
    const capabilities = new Capabilities(
      { summary: new FunctionAction({ fn: () => ({ resumen: 'x' }) }) },
      bus,
    )
    await expect(capabilities.invoke(SUMMARY, { text: 1 } as never)).rejects.toThrow()
    await expect(capabilities.invoke(SUMMARY, { text: 'x' })).rejects.toThrow(
      /no cumple el contrato/,
    )
  })

  it('an agent renders the input in its prompt and delivers the answer under submit_*.result', async () => {
    const seen: ProviderRunContext[] = []
    const capabilities = new Capabilities(
      { summary: agentCalling('submit_done', { result: { summary: 'corto' } }, seen) },
      bus,
    )

    expect(await capabilities.invoke(SUMMARY, { text: 'largo' })).toEqual({ summary: 'corto' })
    expect(seen[0]?.prompt).toBe('Resumí: largo')
    const submit = seen[0]?.tools.find((tool) => tool.name === 'submit_done')
    expect(submit?.inputSchema).toMatchObject({ required: ['result'] })
  })

  it('every exit of the agent leads to the result, without its own destinations or report', async () => {
    const reported: string[] = []
    const report = new FunctionAction({ id: 'report', fn: () => void reported.push('report') })
    const agent = agentCalling('submit_short', { result: { summary: 'ok' } }, [], {
      short: { when: 'es corto', to: END, report },
      long: { when: 'es largo', to: END },
    })
    const capabilities = new Capabilities({ summary: agent }, bus)

    expect(await capabilities.invoke(SUMMARY, { text: 'x' })).toEqual({ summary: 'ok' })
    expect(reported).toEqual([])
  })

  it('an agent that ends without choosing an exit fails the invocation', async () => {
    const capabilities = new Capabilities(
      { summary: agentCalling('fail_turn', { reason: 'no sé' }) },
      bus,
    )
    await expect(capabilities.invoke(SUMMARY, { text: 'x' })).rejects.toThrow(/no sé/)
  })

  it('resolves the binding on every call (a source that reloads)', async () => {
    let bound: FunctionAction | undefined
    const capabilities = new Capabilities(() => bound, bus)
    expect(capabilities.has('summary')).toBe(false)
    bound = new FunctionAction({ fn: () => ({ summary: 'ya' }) })
    expect(await capabilities.invoke(SUMMARY, { text: 'x' })).toEqual({ summary: 'ya' })
  })
})
