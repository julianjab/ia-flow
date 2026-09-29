import { describe, expect, it } from 'vitest'
import { Condition } from '../../condition/Condition.js'
import { createEvent } from '../../events/DomainEvent.js'
import { EventBus } from '../../events/EventBus.js'
import { type PipelineExecutionContext, Runnable } from '../Runnable.js'

class NoopAction extends Runnable {
  async run(_ctx: PipelineExecutionContext): Promise<unknown> {
    return 'ran'
  }
}

function makeCtx(
  payload: Record<string, unknown> = {},
  steps: Record<string, unknown> = {},
): PipelineExecutionContext {
  return {
    event: createEvent('t', payload),
    steps,
    bus: new EventBus(),
    pipelineId: 'p1',
  }
}

describe('Runnable', () => {
  it('defaults id/when/continueOnError', () => {
    const action = new NoopAction({})
    expect(action.id).toBeUndefined()
    expect(action.when).toEqual([])
    expect(action.continueOnError).toBe(false)
  })

  it('shouldRun is true with no `when`', () => {
    const action = new NoopAction({})
    expect(action.shouldRun(makeCtx())).toBe(true)
  })

  it('shouldRun evaluates `when` against the event payload', () => {
    const action = new NoopAction({
      when: Condition.fromRows([{ field: 'actionable', op: 'eq', value: true }]),
    })
    expect(action.shouldRun(makeCtx({ actionable: true }))).toBe(true)
    expect(action.shouldRun(makeCtx({ actionable: false }))).toBe(false)
  })

  it('shouldRun can read prior steps via the injected `steps` key', () => {
    const action = new NoopAction({
      when: Condition.fromRows([
        { field: 'steps.triage.output.actionable', op: 'eq', value: true },
      ]),
    })
    expect(action.shouldRun(makeCtx({}, { triage: { output: { actionable: true } } }))).toBe(true)
    expect(action.shouldRun(makeCtx({}, { triage: { output: { actionable: false } } }))).toBe(false)
  })

  it('shouldRun combines multiple `when` entries with and/or', () => {
    const action = new NoopAction({
      when: Condition.fromRows([
        { field: 'a', op: 'eq', value: 1 },
        { field: 'b', op: 'eq', value: 2, logic: 'or' },
      ]),
    })
    expect(action.shouldRun(makeCtx({ a: 0, b: 2 }))).toBe(true)
    expect(action.shouldRun(makeCtx({ a: 0, b: 0 }))).toBe(false)
  })

  it('run executes the concrete implementation', async () => {
    const action = new NoopAction({})
    await expect(action.run(makeCtx())).resolves.toBe('ran')
  })

  it('shouldRun does not crash when the payload is not an object (still evaluates against `steps`)', () => {
    const action = new NoopAction({
      when: Condition.fromRows([
        { field: 'steps.triage.output.actionable', op: 'eq', value: true },
      ]),
    })
    const ctx: PipelineExecutionContext = {
      event: createEvent('t', 'a plain string payload' as unknown as Record<string, unknown>),
      steps: { triage: { output: { actionable: true } } },
      bus: new EventBus(),
      pipelineId: 'p1',
    }
    expect(action.shouldRun(ctx)).toBe(true)
  })

  it('the reserved `steps` key shadows a same-named field on the payload (documented, not a bug)', () => {
    const action = new NoopAction({
      when: Condition.fromRows([
        { field: 'steps.triage.output.actionable', op: 'eq', value: true },
      ]),
    })
    // Un payload de dominio que también trae una clave `steps` (ej. un itinerario con
    // escalas) queda tapado por `ctx.steps` — ver el comentario de `evaluateWhen`.
    const ctx = makeCtx({ steps: ['layover-mad'] }, { triage: { output: { actionable: true } } })
    expect(action.shouldRun(ctx)).toBe(true)
  })
})
