import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createEvent } from '../../../events/DomainEvent.js'
import { EventBus } from '../../../events/EventBus.js'
import type { PipelineExecutionContext } from '../../Runnable.js'
import { EmitAction } from '../EmitAction.js'

function makeCtx(bus = new EventBus()): PipelineExecutionContext {
  return {
    event: createEvent('t', {}, { depth: 1 }),
    steps: {},
    bus,
    pipelineId: 'p1',
  }
}

describe('EmitAction', () => {
  it('publishes a derived event with a fixed payload', async () => {
    const bus = new EventBus()
    const publishSpy = vi.spyOn(bus, 'publish')

    const event = await new EmitAction({ type: 'wait.resumed', payload: { ok: true } }).run(
      makeCtx(bus),
    )

    expect(publishSpy).toHaveBeenCalledTimes(1)
    expect(event).toMatchObject({ type: 'wait.resumed', payload: { ok: true }, depth: 2 })
  })

  it('defaults to an empty payload when none is given', async () => {
    const event = await new EmitAction({ type: 'x' }).run(makeCtx())
    expect(event).toMatchObject({ type: 'x', payload: {} })
  })

  it('resolves a payload function against the execution context', async () => {
    const ctx = makeCtx()
    ctx.steps.triage = { output: { label: 'bug' } }

    const event = await new EmitAction({
      type: 'triaged',
      payload: (c) => ({ label: (c.steps.triage as { output: { label: string } }).output.label }),
    }).run(ctx)

    expect(event).toMatchObject({ type: 'triaged', payload: { label: 'bug' } })
  })

  it('inherits the parent scope by default', async () => {
    const ctx = makeCtx()
    ctx.event = createEvent('t', {}, { scope: { projectId: 'p' } })
    const event = await new EmitAction({ type: 'x' }).run(ctx)
    expect(event).toMatchObject({ scope: { projectId: 'p' } })
  })

  it('sets the scope a previous step resolved, for an event that arrived without one', async () => {
    const ctx = makeCtx()
    ctx.steps.resolve = { projectId: 'lahaus' }

    const event = await new EmitAction({
      type: 'issue_comment',
      scope: (c) => ({ projectId: (c.steps.resolve as { projectId: string }).projectId }),
    }).run(ctx)

    expect(event).toMatchObject({
      type: 'issue_comment',
      scope: { projectId: 'lahaus' },
      depth: 2,
    })
  })

  it('accepts a fixed scope, and falls back to the parent when the function returns undefined', async () => {
    expect(await new EmitAction({ type: 'x', scope: { repo: 'r' } }).run(makeCtx())).toMatchObject({
      scope: { repo: 'r' },
    })
    const ctx = makeCtx()
    ctx.event = createEvent('t', {}, { scope: { projectId: 'p' } })
    expect(await new EmitAction({ type: 'x', scope: () => undefined }).run(ctx)).toMatchObject({
      scope: { projectId: 'p' },
    })
  })

  describe('typed input', () => {
    const input = z.strictObject({ tripId: z.string() })

    it('without a payload, the validated input is the payload', async () => {
      const event = await new EmitAction({ type: 'trip.booked', input }).run(makeCtx(), {
        tripId: 't1',
      })

      expect(event).toMatchObject({ type: 'trip.booked', payload: { tripId: 't1' } })
    })

    it('a payload function receives the validated input', async () => {
      const event = await new EmitAction({
        type: 'trip.booked',
        input,
        payload: (_ctx, value) => ({ id: value?.tripId, source: 'agent' }),
      }).run(makeCtx(), { tripId: 't1' })

      expect(event).toMatchObject({ payload: { id: 't1', source: 'agent' } })
    })

    it('rejects an invalid input without publishing', async () => {
      const bus = new EventBus()
      const publishSpy = vi.spyOn(bus, 'publish')

      await expect(
        new EmitAction({ id: 'emit', type: 'x', input }).run(makeCtx(bus), {}),
      ).rejects.toThrow(/emit: input inválido/)
      expect(publishSpy).not.toHaveBeenCalled()
    })
  })
})
