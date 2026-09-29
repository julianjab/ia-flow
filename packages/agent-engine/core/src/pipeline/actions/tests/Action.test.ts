import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvent } from '../../../events/DomainEvent.js'
import { EventBus } from '../../../events/EventBus.js'
import type { PipelineExecutionContext } from '../../Runnable.js'
import { Action, AllowedAction, BoundAction } from '../Action.js'

const UpdateIssueInput = z.strictObject({
  status: z.string().optional(),
  labels: z.array(z.string()).optional(),
  comment: z.string().optional(),
})

class UpdateIssue extends Action<typeof UpdateIssueInput> {
  readonly description = 'Actualiza el issue'
  readonly input = UpdateIssueInput
  calls: Array<z.infer<typeof UpdateIssueInput>> = []

  constructor() {
    super({ id: 'update_issue' })
  }

  execute(input: z.infer<typeof UpdateIssueInput>) {
    this.calls.push(input)
    return { ok: true, ...input }
  }
}

const SearchInput = z.strictObject({ query: z.string() })

class Search extends Action<typeof SearchInput, string> {
  readonly description = 'Busca'
  readonly input = SearchInput
  override readonly sideEffects = 'none' as const
  seenPipeline = ''

  constructor() {
    super({ id: 'search' })
  }

  execute(input: z.infer<typeof SearchInput>, ctx: PipelineExecutionContext): string {
    this.seenPipeline = ctx.pipelineId
    return `resultados de ${input.query}`
  }
}

function ctx(): PipelineExecutionContext {
  return { event: createEvent('t', {}), steps: {}, bus: new EventBus(), pipelineId: 'p1' }
}

describe('Action', () => {
  it('rejects an id that cannot be a tool name', () => {
    class Bad extends Action {
      readonly description = 'x'
      readonly input = z.strictObject({})
      execute() {
        return null
      }
    }

    expect(() => new Bad({ id: 'no spaces' })).toThrow(/id "no spaces" inválido/)
  })

  it('defaults sideEffects to write', () => {
    expect(new UpdateIssue().sideEffects).toBe('write')
    expect(new Search().sideEffects).toBe('none')
  })

  it('exposes its input schema through acceptsInput', () => {
    const action = new UpdateIssue()

    expect(action.acceptsInput()).toBe(UpdateIssueInput)
  })

  it('run validates the input before execute', async () => {
    const action = new UpdateIssue()

    await expect(action.run(ctx(), { status: 3 })).rejects.toThrow(
      /update_issue: input inválido[\s\S]*→ at status/,
    )
    await expect(action.run(ctx(), { priority: 'high' })).rejects.toThrow(
      /Unrecognized key: "priority"/,
    )
    expect(action.calls).toEqual([])
  })

  it('run treats a missing input as {}', async () => {
    const action = new UpdateIssue()

    await action.run(ctx())

    expect(action.calls).toEqual([{}])
  })

  describe('bind', () => {
    it('fixes fields and removes them from the schema the model sees', async () => {
      const bound = new UpdateIssue().bind({ status: 'Build' })

      expect(bound).toBeInstanceOf(BoundAction)
      expect(bound.id).toBe('update_issue')
      expect(Object.keys(bound.input.shape).sort()).toEqual(['comment', 'labels'])
    })

    it('merges fixed fields over the given input, so the model cannot override them', async () => {
      const action = new UpdateIssue()
      const bound = action.bind({ status: 'Build' })

      await bound.run(ctx(), { labels: ['x'] })

      expect(action.calls).toEqual([{ labels: ['x'], status: 'Build' }])
    })

    it('rejects an attempt to pass a fixed field, since it is no longer in the schema', async () => {
      const bound = new UpdateIssue().bind({ status: 'Build' })

      await expect(bound.run(ctx(), { status: 'Done' })).rejects.toThrow(
        /Unrecognized key: "status"/,
      )
    })

    it('fails at bind time for a field the input does not declare', () => {
      expect(() => new UpdateIssue().bind({ priority: 'high' } as never)).toThrow(
        /campos que el input no declara: priority/,
      )
    })

    it('fails at bind time for a value that does not match the schema', () => {
      expect(() => new UpdateIssue().bind({ status: 3 } as never)).toThrow(
        /update_issue.bind: valores inválidos/,
      )
    })

    it('keeps sideEffects of the original action', () => {
      expect(new UpdateIssue().bind({ status: 'x' }).sideEffects).toBe('write')
    })
  })

  describe('asTool', () => {
    it('becomes a tool with the same name, description and schema', () => {
      const tool = new Search().asTool(ctx())

      expect(tool.name).toBe('search')
      expect(tool.description).toBe('Busca')
      expect(tool.inputSchema).toMatchObject({
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      })
    })

    it('runs the action with the captured ctx and returns strings as-is', async () => {
      const action = new Search()
      const tool = action.asTool(ctx())

      expect(await tool.handler({ query: 'bug' })).toBe('resultados de bug')
      expect(action.seenPipeline).toBe('p1')
    })

    it('serializes non-string results as JSON', async () => {
      const tool = new UpdateIssue().asTool(ctx())

      expect(JSON.parse(await tool.handler({ status: 'Build' }))).toEqual({
        ok: true,
        status: 'Build',
      })
    })

    it('a bound action as tool only asks for the unbound fields', () => {
      const tool = new UpdateIssue().bind({ status: 'Build' }).asTool(ctx())

      expect(Object.keys(tool.inputSchema.properties as object).sort()).toEqual([
        'comment',
        'labels',
      ])
    })

    it('rejects invalid input from the model without running the action', async () => {
      const action = new UpdateIssue()
      const tool = action.asTool(ctx())

      await expect(tool.handler({ status: 1 })).rejects.toThrow(/input inválido/)
      expect(action.calls).toEqual([])
    })
  })

  it('allowWrite wraps the action as an explicit permission', () => {
    const action = new UpdateIssue()
    const allowed = action.allowWrite()

    expect(allowed).toBeInstanceOf(AllowedAction)
    expect(allowed.action).toBe(action)
  })
})
