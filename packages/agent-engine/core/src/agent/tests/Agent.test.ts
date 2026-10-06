import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { Action } from '../../pipeline/actions/Action.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import type { PipelineExecutionContext } from '../../pipeline/Runnable.js'
import { END } from '../../routing/ExitRoutes.js'
import { Agent } from '../Agent.js'
import type { Tool } from '../AgentDefinition.js'
import type { Provider, ProviderRunContext } from '../Provider.js'
import { ProviderRegistry } from '../Provider.js'

function registerFakeProvider(id: string, run: Provider['run']): ProviderRegistry {
  return new ProviderRegistry().register({ id, run })
}

/** Un provider que "llama" una tool como lo haría el modelo, y termina. Como un provider real,
 *  un rechazo de la tool no lo tumba: queda en `errors` (lo que vería el modelo). */
function callingProvider(name: string, input: unknown, errors: string[] = []): ProviderRegistry {
  return registerFakeProvider('fake', async (ctx) => {
    const tool = ctx.tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`el agente no ofreció ${name}`)
    try {
      await tool.handler(input)
    } catch (err) {
      errors.push((err as Error).message)
    }
    return { outcome: 'success' }
  })
}

function ctxFor(
  payload: Record<string, unknown> = {},
  steps: Record<string, unknown> = {},
): PipelineExecutionContext {
  return { event: createEvent('t', payload), steps, bus: new EventBus(), pipelineId: 'p1' }
}

const UpdateIssueInput = z.strictObject({
  status: z.string().optional(),
  comment: z.string().optional(),
})

class UpdateIssue extends Action<typeof UpdateIssueInput> {
  readonly description = 'Actualiza el issue'
  readonly input = UpdateIssueInput
  constructor() {
    super({ id: 'update_issue' })
  }
  execute() {
    return null
  }
}

const SearchInput = z.strictObject({ query: z.string() })

class Search extends Action<typeof SearchInput> {
  readonly description = 'Busca tareas'
  readonly input = SearchInput
  override readonly sideEffects = 'none' as const
  constructor() {
    super({ id: 'search_tasks' })
  }
  execute() {
    return []
  }
}

const NotifyInput = z.strictObject({ summary: z.string() })

class Notify extends Action<typeof NotifyInput> {
  readonly description = 'Notifica'
  readonly input = NotifyInput
  constructor() {
    super({ id: 'notify' })
  }
  execute() {
    return null
  }
}

describe('Agent', () => {
  it('is a Runnable — inherits id/when/continueOnError from the definition', () => {
    const registry = registerFakeProvider('fake', async () => ({ outcome: 'success' }))
    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        when: Condition.fromRows([{ field: 'go', op: 'eq', value: true }]),
        continueOnError: true,
      },
      registry,
    )

    expect(agent.id).toBe('x')
    expect(agent.continueOnError).toBe(true)
    expect(agent.shouldRun(ctxFor({ go: true }))).toBe(true)
    expect(agent.shouldRun(ctxFor({ go: false }))).toBe(false)
  })

  it('throws a clear error when the provider id is not registered', async () => {
    const agent = new Agent(
      { id: 'x', provider: 'does-not-exist', prompt: 'hola' },
      new ProviderRegistry(),
    )
    await expect(agent.run(ctxFor())).rejects.toThrow(/provider desconocido "does-not-exist"/)
  })

  it('interpolates {{path}} in the prompt against the event payload', async () => {
    let receivedPrompt = ''
    const registry = registerFakeProvider('fake', async (ctx) => {
      receivedPrompt = ctx.prompt
      return { outcome: 'success' }
    })

    const agent = new Agent(
      { id: 'x', provider: 'fake', prompt: 'Hola {{name}}, tu issue es {{title}}' },
      registry,
    )
    await agent.run(ctxFor({ name: 'Julian', title: 'bug X' }))

    expect(receivedPrompt).toBe('Hola Julian, tu issue es bug X')
  })

  it('interpolates {{variables.x}} against the agent-declared variables', async () => {
    let receivedPrompt = ''
    const registry = registerFakeProvider('fake', async (ctx) => {
      receivedPrompt = ctx.prompt
      return { outcome: 'success' }
    })

    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'Repo: {{variables.repo}}',
        variables: { repo: 'julianjab/accountant' },
      },
      registry,
    )
    await agent.run(ctxFor())

    expect(receivedPrompt).toBe('Repo: julianjab/accountant')
  })

  it('an unresolved placeholder is left as-is (fail-open), not thrown', async () => {
    let receivedPrompt = ''
    const registry = registerFakeProvider('fake', async (ctx) => {
      receivedPrompt = ctx.prompt
      return { outcome: 'success' }
    })

    const agent = new Agent({ id: 'x', provider: 'fake', prompt: 'Valor: {{typo}}' }, registry)
    await agent.run(ctxFor())

    expect(receivedPrompt).toBe('Valor: {{typo}}')
  })

  it('joins systemPrompts by resolved text, dropping refs with neither text nor a match', async () => {
    let received: string[] = []
    const registry = registerFakeProvider('fake', async (ctx) => {
      received = ctx.systemPrompts
      return { outcome: 'success' }
    })

    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        systemPrompts: [{ text: 'uno' }, { id: 'no-catalog-here' }, { text: 'dos' }],
      },
      registry,
    )
    await agent.run(ctxFor())

    expect(received).toEqual(['uno', 'dos'])
  })

  it('passes tools, providerConfig and mcpServers through to the provider', async () => {
    let received: ProviderRunContext | undefined
    const registry = registerFakeProvider('fake', async (ctx) => {
      received = ctx
      return { outcome: 'success' }
    })

    const tool = { name: 't', description: 'd', inputSchema: {}, handler: () => 'x' }
    const agent = new Agent(
      {
        id: 'x',
        provider: 'fake',
        prompt: 'p',
        tools: [tool],
        providerConfig: { model: 'x' },
        mcpServers: [{ id: 'gh', config: { url: 'https://x' } }],
      },
      registry,
    )
    await agent.run(ctxFor())

    expect(received?.tools[0]).toBe(tool)
    expect(received?.providerConfig).toEqual({ model: 'x' })
    expect(received?.mcpServers).toEqual([{ id: 'gh', config: { url: 'https://x' } }])
  })

  describe('input', () => {
    const agentWithInput = (registry: ProviderRegistry) =>
      new Agent(
        {
          id: 'refiner',
          provider: 'fake',
          prompt: 'Ajustá el PRD: {{input.summary}}',
          input: z.strictObject({ summary: z.string().optional() }),
        },
        registry,
      )

    it('validates the input and exposes it as {{input.x}}', async () => {
      let receivedPrompt = ''
      const registry = registerFakeProvider('fake', async (ctx) => {
        receivedPrompt = ctx.prompt
        return { outcome: 'success' }
      })

      await agentWithInput(registry).run(ctxFor(), { summary: 'agregar paginación' })

      expect(receivedPrompt).toBe('Ajustá el PRD: agregar paginación')
    })

    it('rejects an invalid input before calling the provider', async () => {
      let called = false
      const registry = registerFakeProvider('fake', async () => {
        called = true
        return { outcome: 'success' }
      })

      await expect(agentWithInput(registry).run(ctxFor(), { summary: 3 })).rejects.toThrow(
        /refiner: input inválido[\s\S]*→ at summary/,
      )
      expect(called).toBe(false)
    })

    it('declares its input through acceptsInput, and none when it has no schema', () => {
      const registry = new ProviderRegistry()

      expect(agentWithInput(registry).acceptsInput()).toBeDefined()
      expect(new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry).acceptsInput()).toBe(
        undefined,
      )
    })
  })

  describe('exits', () => {
    const updateIssue = new UpdateIssue()
    const routes = {
      done: { when: 'El PRD quedó listo', to: updateIssue.bind({ status: 'Refined' }) },
      back_to_build: { when: 'Falla la implementación', to: updateIssue.bind({ status: 'Build' }) },
    }

    it('offers one terminal submit_<exit> tool per exit, described by its `when`', async () => {
      let tools: Tool[] = []
      const registry = registerFakeProvider('fake', async (ctx) => {
        tools = ctx.tools
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
        return { outcome: 'success' }
      })

      await new Agent({ id: 'refiner', provider: 'fake', prompt: 'p', routes }, registry).run(
        ctxFor(),
      )

      expect(tools.map((tool) => [tool.name, tool.terminal])).toEqual([
        ['submit_done', true],
        ['submit_back_to_build', true],
        ['fail_turn', true],
      ])
      expect(tools[1]?.description).toMatch(/Usala cuando: Falla la implementación/)
    })

    it('returns the exit the model submitted, with its payload', async () => {
      const registry = callingProvider('submit_back_to_build', {
        update_issue: { comment: 'el test de X falla' },
      })

      const result = await new Agent(
        { id: 'refiner', provider: 'fake', prompt: 'p', routes },
        registry,
      ).run(ctxFor())

      expect(result.exit).toBe('back_to_build')
      expect(result.payload).toEqual({ update_issue: { comment: 'el test de X falla' } })
    })

    it('the submit schema asks for each destination input, minus the fields fixed by bind', async () => {
      const errors: string[] = []
      const registry = callingProvider('submit_done', { update_issue: { status: 'Done' } }, errors)
      const agent = new Agent({ id: 'refiner', provider: 'fake', prompt: 'p', routes }, registry)

      // El modelo recibe el rechazo (el status lo fijó el operador con bind). Si igual termina sin
      // un submit válido y hay más de una salida, la corrida no adivina: falla.
      await expect(agent.run(ctxFor())).rejects.toThrow(/terminó sin elegir salida/)
      expect(errors[0]).toMatch(/submit_done: input inválido[\s\S]*Unrecognized key: "status"/)
    })

    it('rejects a second submit in the same turn', async () => {
      const registry = registerFakeProvider('fake', async (ctx) => {
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
        await ctx.tools.find((tool) => tool.name === 'submit_back_to_build')?.handler({})
        return { outcome: 'success' }
      })

      await expect(
        new Agent({ id: 'refiner', provider: 'fake', prompt: 'p', routes }, registry).run(ctxFor()),
      ).rejects.toThrow(/Ya elegiste la salida "done"/)
    })

    it('an agent without declared exits gets an implicit "done", chosen without a submit', async () => {
      const registry = registerFakeProvider('fake', async () => ({ outcome: 'success' }))

      const result = await new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry).run(
        ctxFor(),
      )

      expect(result.exit).toBe('done')
      expect(result.payload).toEqual({})
    })

    it('a provider without tools can pick an exit by outcome name when it needs no data', async () => {
      const registry = registerFakeProvider('fake', async () => ({ outcome: 'back_to_build' }))

      const result = await new Agent(
        { id: 'refiner', provider: 'fake', prompt: 'p', routes },
        registry,
      ).run(ctxFor())

      expect(result.exit).toBe('back_to_build')
    })

    it('fails when the model ends without submitting and the exit needs data', async () => {
      const registry = registerFakeProvider('fake', async () => ({ outcome: 'success' }))
      const agent = new Agent(
        {
          id: 'triage',
          provider: 'fake',
          prompt: 'p',
          routes: { actionable: { to: new Notify() }, not_actionable: { to: END } },
        },
        registry,
      )

      await expect(agent.run(ctxFor())).rejects.toThrow(
        /terminó sin elegir salida — tenía que llamar a submit_actionable, submit_not_actionable/,
      )
    })

    it('cancelled/truncated outcomes resolve to no exit at all', async () => {
      const registry = registerFakeProvider('fake', async () => ({ outcome: 'truncated' }))

      const result = await new Agent(
        { id: 'refiner', provider: 'fake', prompt: 'p', routes },
        registry,
      ).run(ctxFor())

      expect(result.exit).toBeUndefined()
    })

    it('an "error" outcome throws, so the pipeline can apply onError', async () => {
      const registry = registerFakeProvider('fake', async () => ({
        outcome: 'error',
        summary: 'sin acceso al repo',
      }))

      await expect(
        new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry).run(ctxFor()),
      ).rejects.toThrow(/el provider reportó error: sin acceso al repo/)
    })

    it('rejects a base route that points to another agent', () => {
      const registry = new ProviderRegistry()
      const other = new Agent({ id: 'implementer', provider: 'fake', prompt: 'p' }, registry)

      expect(
        () =>
          new Agent(
            { id: 'refiner', provider: 'fake', prompt: 'p', routes: { done: { to: other } } },
            registry,
          ),
      ).toThrow(/una ruta base apunta al agente "implementer"/)
    })
  })

  describe('fail_turn', () => {
    it('is always offered, as a terminal failure tool', async () => {
      let tools: Tool[] = []
      const registry = registerFakeProvider('fake', async (ctx) => {
        tools = ctx.tools
        return { outcome: 'success' }
      })

      await new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry).run(ctxFor())

      const fail = tools.find((tool) => tool.name === 'fail_turn')
      expect(fail).toMatchObject({ terminal: true, failure: true })
    })

    it('makes the run fail with the model reason, so the pipeline applies onError', async () => {
      const registry = callingProvider('fail_turn', { reason: 'el PRD es ambiguo sobre X' })

      await expect(
        new Agent({ id: 'refiner', provider: 'fake', prompt: 'p' }, registry).run(ctxFor()),
      ).rejects.toThrow('Agent(refiner): el agente declaró que falló: el PRD es ambiguo sobre X')
    })

    it('cannot be combined with a submit in the same turn', async () => {
      const errors: string[] = []
      const registry = registerFakeProvider('fake', async (ctx) => {
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
        try {
          await ctx.tools.find((tool) => tool.name === 'fail_turn')?.handler({ reason: 'x' })
        } catch (err) {
          errors.push((err as Error).message)
        }
        return { outcome: 'success' }
      })

      const result = await new Agent({ id: 'x', provider: 'fake', prompt: 'p' }, registry).run(
        ctxFor(),
      )

      expect(errors[0]).toMatch(/Ya elegiste la salida "done"/)
      expect(result.exit).toBe('done')
    })
  })

  describe('actions', () => {
    it('gives read actions to the model as tools', async () => {
      let names: string[] = []
      const registry = registerFakeProvider('fake', async (ctx) => {
        names = ctx.tools.map((tool) => tool.name)
        return { outcome: 'success' }
      })

      await new Agent(
        { id: 'chat', provider: 'fake', prompt: 'p', actions: [new Search()] },
        registry,
      ).run(ctxFor())

      expect(names).toEqual(['search_tasks', 'submit_done', 'fail_turn'])
    })

    it('rejects a writing action unless it is passed through allowWrite()', () => {
      const registry = new ProviderRegistry()

      expect(
        () =>
          new Agent(
            { id: 'chat', provider: 'fake', prompt: 'p', actions: [new UpdateIssue()] },
            registry,
          ),
      ).toThrow(/la acción "update_issue" escribe — pasala como update_issue.allowWrite\(\)/)
      expect(
        () =>
          new Agent(
            {
              id: 'chat',
              provider: 'fake',
              prompt: 'p',
              actions: [new UpdateIssue().allowWrite()],
            },
            registry,
          ),
      ).not.toThrow()
    })

    it('rejects two tools with the same name', async () => {
      const registry = registerFakeProvider('fake', async () => ({ outcome: 'success' }))
      const clash = { name: 'search_tasks', description: 'd', inputSchema: {}, handler: () => '' }

      await expect(
        new Agent(
          { id: 'chat', provider: 'fake', prompt: 'p', tools: [clash], actions: [new Search()] },
          registry,
        ).run(ctxFor()),
      ).rejects.toThrow(/dos tools con el nombre "search_tasks"/)
    })
  })

  it('onStart runs before the provider', async () => {
    const order: string[] = []
    const registry = registerFakeProvider('fake', async () => {
      order.push('provider')
      return { outcome: 'success' }
    })

    await new Agent(
      {
        id: 'implementer',
        provider: 'fake',
        prompt: 'p',
        onStart: new FunctionAction({ fn: () => order.push('onStart') }),
      },
      registry,
    ).run(ctxFor())

    expect(order).toEqual(['onStart', 'provider'])
  })

  it('onStart accepts a list and runs it in order, before the provider', async () => {
    const order: string[] = []
    const registry = registerFakeProvider('fake', async () => {
      order.push('provider')
      return { outcome: 'success' }
    })

    await new Agent(
      {
        id: 'implementer',
        provider: 'fake',
        prompt: 'p',
        onStart: [
          new FunctionAction({ fn: () => order.push('clear-labels') }),
          new FunctionAction({ fn: () => order.push('link-branch') }),
        ],
      },
      registry,
    ).run(ctxFor())

    expect(order).toEqual(['clear-labels', 'link-branch', 'provider'])
  })

  it('a failing onStart step stops the agent before the provider', async () => {
    const provider = vi.fn(async () => ({ outcome: 'success' }))
    const registry = registerFakeProvider('fake', provider)
    const agent = new Agent(
      {
        id: 'implementer',
        provider: 'fake',
        prompt: 'p',
        onStart: [
          new FunctionAction({
            fn: () => {
              throw new Error('no se pudo vincular la rama')
            },
          }),
        ],
      },
      registry,
    )

    await expect(agent.run(ctxFor())).rejects.toThrow('no se pudo vincular la rama')
    expect(provider).not.toHaveBeenCalled()
  })

  it('hands its provider the execution inbox, and none outside an execution', async () => {
    const seen: Array<string[] | undefined> = []
    const registry = registerFakeProvider('fake', async (ctx) => {
      seen.push(await ctx.inbox?.())
      return { outcome: 'success' }
    })
    const agent = new Agent({ id: 'implementer', provider: 'fake', prompt: 'p' }, registry)
    const inbox = ['comentario nuevo']

    const active: Array<string | undefined> = []
    let current: string | undefined
    const execution = {
      id: 'exec-1',
      enter: (step: { id?: string }) => {
        current = step.id
      },
      leave: () => {
        current = undefined
      },
      drain: () => {
        active.push(current)
        return inbox.splice(0)
      },
      pause: () => {},
    }
    await agent.run({ ...ctxFor(), execution })
    expect(active).toEqual(['implementer'])
    expect(current).toBeUndefined()
    await agent.run(ctxFor())

    expect(seen).toEqual([['comentario nuevo'], undefined])
  })
})
