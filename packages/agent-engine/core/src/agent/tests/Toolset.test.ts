import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { Action } from '../../pipeline/actions/Action.js'
import type { Tool } from '../AgentDefinition.js'
import { Toolset } from '../Toolset.js'

class Label extends Action {
  readonly description = 'Pone un label'
  readonly input = z.strictObject({ name: z.string() })
  execute(input: { name: string }): string {
    return `+${input.name}`
  }
}
class Read extends Action {
  readonly description = 'Lee el issue'
  readonly input = z.strictObject({})
  override readonly sideEffects = 'none' as const
  execute(): string {
    return 'issue'
  }
}

const plain = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: {},
  handler: () => '',
})
const ctx = { event: createEvent('e', {}), steps: {}, bus: new EventBus(), pipelineId: 'p' }

describe('Toolset', () => {
  it('refuses an action that writes unless it was allowed', () => {
    expect(() => new Toolset('a', [], [new Label({ id: 'label' })])).toThrow(
      /"label" escribe — pasala como label.allowWrite\(\)/,
    )
    expect(
      new Toolset(
        'a',
        [plain('grep')],
        [new Label({ id: 'label' }).allowWrite(), new Read({ id: 'read' })],
      ).names,
    ).toEqual(['grep', 'label', 'read'])
  })

  it('builds the tools of a run, and refuses two with the same name', async () => {
    const toolset = new Toolset('a', [plain('grep')], [new Read({ id: 'read' })])
    const tools = toolset.forRun(ctx, [plain('submit_done')])
    expect(tools.map((tool) => tool.name)).toEqual(['grep', 'read', 'submit_done'])
    expect(await tools[1]?.handler({})).toBe('issue')
    expect(() => toolset.forRun(ctx, [plain('grep')])).toThrow(/dos tools con el nombre "grep"/)
  })
})
