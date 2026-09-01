import { describe, expect, test } from 'bun:test'
import type { DispatchOutcome, IIssueManager, IssueItem } from '@ia-flow/issue-sources'
import type { ActionContext } from '@ia-flow/rules'
import { createEvent } from '@ia-flow/shared'
import { AgentAction } from '../agent-action.js'

// El `brief` es lo único de una regla que el MODELO lee, así que lo que se
// testea es el contrato de esa frontera: que llegue rendido al dispatcher, y
// que un brief ausente no invente un argumento.

const item = { id: 'I_1', title: 'una task' } as unknown as IssueItem
const manager = {} as IIssueManager

const ctx = (payload: Record<string, unknown> = {}): ActionContext =>
  ({
    event: createEvent({
      type: 'pr.opened',
      source: 'github',
      scope: { projectId: 'p1' },
      payload: { item, ...payload },
    }),
    rule: { id: 'r1' },
    position: 0,
    emit: async () => {},
  }) as unknown as ActionContext

/** Captura el `brief` con el que se llamó al dispatcher. */
function spyDispatch(outcome: DispatchOutcome = 'dispatched') {
  const calls: Array<string | undefined> = []
  return {
    calls,
    action: new AgentAction({
      managerFor: () => manager,
      dispatch: async (_i, _m, _a, _r, _e, brief) => {
        calls.push(brief)
        return outcome
      },
    }),
  }
}

describe('AgentAction — brief', () => {
  test('baja el brief con las variables del evento ya resueltas', async () => {
    const { action, calls } = spyDispatch()
    await action.execute(ctx({ pr: { number: 482 } }), {
      action: 'agent',
      agentId: 'implementer',
      brief: 'Revisá el PR #{{event.payload.pr.number}} ({{event.type}}).',
    } as never)
    expect(calls[0]).toBe('Revisá el PR #482 (pr.opened).')
  })

  test('sin brief no manda nada — el agente corre con su prompt de siempre', async () => {
    const { action, calls } = spyDispatch()
    await action.execute(ctx(), { action: 'agent', agentId: 'implementer' } as never)
    expect(calls[0]).toBeUndefined()
  })

  // Un brief que quedó en blanco al editar la regla es "sin brief", no un
  // encabezado vacío colgando arriba del prompt.
  test('un brief en blanco cuenta como ausente', async () => {
    const { action, calls } = spyDispatch()
    await action.execute(ctx(), {
      action: 'agent',
      agentId: 'implementer',
      brief: '   \n  ',
    } as never)
    expect(calls[0]).toBeUndefined()
  })
})
