import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { END, resolveRoutes } from '../../routing/ExitRoutes.js'
import { FAIL_TOOL_NAME } from '../FailTool.js'
import { TurnProtocol } from '../TurnProtocol.js'
import { YIELD_TOOL_NAME } from '../YieldTool.js'

const routes = resolveRoutes('implementer', {
  routes: {
    done: { to: END },
    blocked: {
      to: new FunctionAction({
        id: 'label',
        input: z.strictObject({ reason: z.string() }),
        fn: () => undefined,
      }),
    },
  },
})
const tool = (turn: TurnProtocol, name: string) =>
  turn.tools.find((candidate) => candidate.name === name)

describe('TurnProtocol', () => {
  it('offers one submit tool per exit plus fail_turn', () => {
    const turn = new TurnProtocol('implementer', routes)
    expect(turn.tools.map((t) => t.name)).toEqual(['submit_done', 'submit_blocked', FAIL_TOOL_NAME])
  })

  it('resolves the exit the model submitted, with its payload', async () => {
    const turn = new TurnProtocol('implementer', routes)
    await tool(turn, 'submit_blocked')?.handler({ label: { reason: 'sin acceso' } })
    expect(turn.resolve({ outcome: 'success' })).toEqual({
      output: { outcome: 'success' },
      exit: 'blocked',
      payload: { label: { reason: 'sin acceso' } },
    })
  })

  it('allows a single choice per turn', async () => {
    const turn = new TurnProtocol('implementer', routes)
    await tool(turn, 'submit_done')?.handler({})
    await expect(tool(turn, FAIL_TOOL_NAME)?.handler({ reason: 'x' })).rejects.toThrow(
      /Ya elegiste la salida "done"/,
    )
  })

  it('fails the turn when the model declares it failed or the provider errored', async () => {
    const failed = new TurnProtocol('implementer', routes)
    await tool(failed, FAIL_TOOL_NAME)?.handler({ reason: 'falta el PRD' })
    expect(() => failed.resolve({ outcome: 'success' })).toThrow(/declaró que falló: falta el PRD/)

    expect(() =>
      new TurnProtocol('implementer', routes).resolve({ outcome: 'error', summary: 'boom' }),
    ).toThrow(/el provider reportó error: boom/)
  })

  it('a cut-off run applies no exit', () => {
    expect(new TurnProtocol('implementer', routes).resolve({ outcome: 'truncated' })).toEqual({
      output: { outcome: 'truncated' },
    })
  })

  it('without a submit, takes the outcome as the exit only if that exit needs no data', () => {
    expect(new TurnProtocol('implementer', routes).resolve({ outcome: 'done' }).exit).toBe('done')
    expect(() => new TurnProtocol('implementer', routes).resolve({ outcome: 'blocked' })).toThrow(
      /terminó sin elegir salida/,
    )
  })

  describe('yield_turn', () => {
    it('is offered only inside an execution', () => {
      expect(tool(new TurnProtocol('implementer', routes), YIELD_TOOL_NAME)).toBeUndefined()
      expect(
        tool(new TurnProtocol('implementer', routes, () => false), YIELD_TOOL_NAME),
      ).toBeDefined()
    })

    it('is refused unless the agent was interrupted', async () => {
      const turn = new TurnProtocol('implementer', routes, () => false)
      await expect(tool(turn, YIELD_TOOL_NAME)?.handler({ progress: 'x' })).rejects.toThrow(
        /Nadie te interrumpió/,
      )
      await tool(turn, 'submit_done')?.handler({})
      expect(turn.resolve({ outcome: 'success' }).exit).toBe('done')
    })

    it('ends the turn with no exit, just where it stopped', async () => {
      const turn = new TurnProtocol('implementer', routes, () => true)
      await tool(turn, YIELD_TOOL_NAME)?.handler({ progress: 'tests escritos, falta el endpoint' })
      expect(turn.resolve({ outcome: 'success' })).toEqual({
        output: { outcome: 'success' },
        progress: 'tests escritos, falta el endpoint',
      })
      await expect(tool(turn, 'submit_done')?.handler({})).rejects.toThrow(/Ya cediste/)
    })
  })
})
