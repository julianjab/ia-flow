import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { Action } from '../../pipeline/actions/Action.js'
import type { PipelineExecutionContext } from '../../pipeline/Runnable.js'
import { Agent } from '../Agent.js'
import type { Provider, ProviderRunContext } from '../Provider.js'
import { ProviderRegistry, toolsFor } from '../Provider.js'

class WriteFile extends Action<z.ZodObject<{ path: z.ZodString }>, string> {
  readonly description = 'escribe un archivo del worktree'
  readonly input = z.strictObject({ path: z.string() })
  override readonly sideEffects = 'none' as const
  override readonly workspace = true
  constructor() {
    super({ id: 'fs_write' })
  }
  execute() {
    return 'ok'
  }
}

class ReadIssue extends Action<z.ZodObject<{ n: z.ZodNumber }>, string> {
  readonly description = 'lee un issue'
  readonly input = z.strictObject({ n: z.number() })
  override readonly sideEffects = 'none' as const
  constructor() {
    super({ id: 'read_issue' })
  }
  execute() {
    return 'el issue'
  }
}

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('build', {}),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'build',
})

/** Un provider que cierra con `submit_done` y guarda qué tools recibió. */
function provider(id: string, workspace?: Provider['workspace']) {
  const runs: ProviderRunContext[] = []
  const p: Provider = {
    id,
    ...(workspace ? { workspace } : {}),
    run: async (run) => {
      runs.push(run)
      await run.tools.find((tool) => tool.name === 'submit_done')?.handler({})
      return { outcome: 'success' }
    },
  }
  return { provider: p, names: () => runs[0]?.tools.map((tool) => tool.name) ?? [] }
}

describe('tools de workspace', () => {
  it('un provider con workspace nativo no las recibe; uno del runner, sí', async () => {
    const cli = provider('claude-cli', 'native')
    const api = provider('anthropic-api')
    const registry = new ProviderRegistry().register(cli.provider).register(api.provider)
    const actions = [new WriteFile(), new ReadIssue()]

    await new Agent({ id: 'a', prompt: 'p', provider: 'claude-cli', actions }, registry).run(ctx())
    await new Agent({ id: 'b', prompt: 'p', provider: 'anthropic-api', actions }, registry).run(
      ctx(),
    )

    expect(cli.names()).toContain('read_issue')
    expect(cli.names()).not.toContain('fs_write')
    expect(api.names()).toEqual(expect.arrayContaining(['read_issue', 'fs_write']))
  })

  it('una acción con campos fijados sigue siendo de workspace', () => {
    expect(new WriteFile().bind({ path: 'a.txt' }).workspace).toBe(true)
    expect(new WriteFile().asTool(ctx()).workspace).toBe(true)
    expect(new ReadIssue().asTool(ctx()).workspace).toBeUndefined()
  })

  it('las terminales nunca son de workspace: siempre llegan', () => {
    const tools = [
      { name: 'fs_read', description: '', inputSchema: {}, handler: () => '', workspace: true },
      { name: 'submit_done', description: '', inputSchema: {}, handler: () => '', terminal: true },
    ]
    expect(toolsFor({ workspace: 'native' }, tools).map((tool) => tool.name)).toEqual([
      'submit_done',
    ])
    expect(toolsFor({}, tools)).toHaveLength(2)
  })
})
