import { describe, expect, it, vi } from 'vitest'
import { createEvent } from '../../events/DomainEvent.js'
import { FunctionAction } from '../../pipeline/actions/FunctionAction.js'
import { Pipeline } from '../../pipeline/Pipeline.js'
import type { Candidate } from '../DispatchPlanner.js'
import { RunLauncher } from '../RunLauncher.js'

const candidate = (id: string): Candidate => ({
  pipeline: new Pipeline({ id, on: ['e'], do: [new FunctionAction({ fn: () => undefined })] }),
  source: { list: () => [] },
})
const event = createEvent('e', {})

describe('RunLauncher', () => {
  it('runs every resolved candidate and reports dispatched', async () => {
    const ran: string[] = []
    const outcome = await new RunLauncher().launch(
      [candidate('a'), candidate('b')],
      event,
      undefined,
      ({ pipeline }) => ({ decision: 'direct', run: async () => ran.push(pipeline.id) }),
    )
    expect(outcome).toBe('dispatched')
    expect(ran).toEqual(['a', 'b'])
  })

  it('with nothing to run, reports what happened with the execution — or skipped', async () => {
    const launcher = new RunLauncher()
    const none = () => ({ decision: 'skipped' as const })
    expect(await launcher.launch([candidate('a')], event, undefined, none)).toBe('skipped')
    expect(
      await launcher.launch(
        [candidate('a')],
        event,
        { kind: 'injected', executionId: 'exec-1' },
        none,
      ),
    ).toBe('injected')
  })

  it('collects every failure in one AggregateError instead of stopping at the first', async () => {
    const launcher = new RunLauncher()
    const ran: string[] = []
    const launch = launcher.launch(
      [candidate('a'), candidate('b'), candidate('c')],
      event,
      undefined,
      ({ pipeline }) => ({
        decision: 'direct',
        run: async () => {
          ran.push(pipeline.id)
          if (pipeline.id !== 'b') throw new Error(`${pipeline.id} falló`)
        },
      }),
    )
    await expect(launch).rejects.toThrow('2 pipeline(s) failed for event "e"')
    expect(ran).toEqual(['a', 'b', 'c'])
  })

  it('does not wait for a detached run, and logs its failure', async () => {
    const launcher = new RunLauncher()
    const error = vi.spyOn(launcher.log, 'error').mockImplementation(() => {})
    let finish!: () => void
    const outcome = await launcher.launch([candidate('a')], event, undefined, () => ({
      decision: 'starts',
      detach: true,
      run: () =>
        new Promise<void>((_, reject) => {
          finish = () => reject(new Error('boom'))
        }),
    }))
    expect(outcome).toBe('dispatched')
    finish()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'))
  })
})
