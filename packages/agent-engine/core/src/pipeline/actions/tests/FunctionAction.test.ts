import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEvent } from '../../../events/DomainEvent.js'
import { EventBus } from '../../../events/EventBus.js'
import type { PipelineExecutionContext } from '../../Runnable.js'
import { FunctionAction } from '../FunctionAction.js'

function makeCtx(): PipelineExecutionContext {
  return {
    event: createEvent('t', { a: 1 }),
    steps: {},
    bus: new EventBus(),
    pipelineId: 'p1',
  }
}

describe('FunctionAction', () => {
  it('runs the given function with the full execution context', async () => {
    let receivedCtx: PipelineExecutionContext | undefined
    const ctx = makeCtx()

    await new FunctionAction({
      fn: (c) => {
        receivedCtx = c
        return 'done'
      },
    }).run(ctx)

    expect(receivedCtx).toBe(ctx)
  })

  it('returns whatever the function returns', async () => {
    const result = await new FunctionAction({ fn: () => ({ ok: true }) }).run(makeCtx())
    expect(result).toEqual({ ok: true })
  })

  it('awaits an async function', async () => {
    const result = await new FunctionAction({
      fn: async () => {
        await Promise.resolve()
        return 'async-done'
      },
    }).run(makeCtx())
    expect(result).toBe('async-done')
  })

  describe('typed input', () => {
    const input = z.strictObject({ summary: z.string() })

    it('validates the input and passes it as the second argument', async () => {
      let received: unknown
      const step = new FunctionAction({
        input,
        fn: (_ctx, value) => {
          received = value
        },
      })

      await step.run(makeCtx(), { summary: 'x' })

      expect(received).toEqual({ summary: 'x' })
      expect(step.acceptsInput()).toBe(input)
    })

    it('rejects an invalid input without running the function', async () => {
      let ran = false
      const step = new FunctionAction({
        id: 'notify',
        input,
        fn: () => {
          ran = true
        },
      })

      await expect(step.run(makeCtx(), { summary: 1 })).rejects.toThrow(
        /notify: input inválido[\s\S]*→ at summary/,
      )
      expect(ran).toBe(false)
    })

    it('without a schema it accepts no input and the function gets undefined', async () => {
      let received: unknown = 'unset'
      const step = new FunctionAction({
        fn: (_ctx, value) => {
          received = value
        },
      })

      await step.run(makeCtx(), { ignored: true })

      expect(received).toBeUndefined()
      expect(step.acceptsInput()).toBeUndefined()
    })
  })
})
