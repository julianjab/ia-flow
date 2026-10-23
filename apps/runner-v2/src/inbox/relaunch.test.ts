import { describe, expect, it } from 'bun:test'
import type { ActivityPort, OpenedBy, StoredEvent } from './ActivityPort.js'
import { noOpReason, relaunchEvent } from './relaunch.js'

const opening: StoredEvent = { id: 'ev-open', type: 'projects_v2_item.edited', payload: {} }
const latest: StoredEvent = { id: 'ev-ci', type: 'check_suite', payload: {} }

/** Una actividad con una última ejecución y los dos eventos: el que la abrió y el último. */
function activity(status: 'failed' | 'done' | undefined) {
  const asked: Array<OpenedBy | undefined> = []
  const port: Pick<ActivityPort, 'executions' | 'lastDispatchedEvent'> = {
    executions: () =>
      status
        ? [
            {
              id: 'e1',
              key: 'k',
              pipeline_id: 'build-reentry',
              status,
              started_at: '2026-10-23T14:59:17.411Z',
            },
          ]
        : [],
    lastDispatchedEvent: (_ref, openedBy) => {
      asked.push(openedBy)
      return openedBy ? opening : latest
    },
  }
  return { port, asked }
}

describe('relaunchEvent', () => {
  it('relaunches the event that opened a failed execution, not the last one of the task', () => {
    const { port, asked } = activity('failed')

    expect(relaunchEvent(port, 'o/r#1')).toBe(opening)
    expect(asked[0]).toEqual({ pipelineId: 'build-reentry', startedAt: '2026-10-23T14:59:17.411Z' })
  })

  it('falls back to the last dispatched event when the opening one is not found', () => {
    const { port } = activity('failed')
    port.lastDispatchedEvent = (_ref, openedBy) => (openedBy ? undefined : latest)

    expect(relaunchEvent(port, 'o/r#1')).toBe(latest)
  })

  it('relaunches the last dispatched event when the last execution did not fail', () => {
    expect(relaunchEvent(activity('done').port, 'o/r#1')).toBe(latest)
    expect(relaunchEvent(activity(undefined).port, 'o/r#1')).toBe(latest)
  })
})

describe('noOpReason', () => {
  it('is undefined when some pipeline runs with the event', () => {
    expect(
      noOpReason(latest, [
        { pipelineId: 'ci-red', sourceId: 'p', verdict: 'mismatch', reason: 'x' },
        { pipelineId: 'build-reentry', sourceId: 'p', verdict: 'ran' },
      ]),
    ).toBeUndefined()
  })

  it('says why nothing would run', () => {
    const reason = noOpReason(latest, [
      {
        pipelineId: 'ci-red',
        sourceId: 'p',
        verdict: 'mismatch',
        reason: 'no cumple: conclusion eq "failure" (vino "success")',
      },
    ])

    expect(reason).toContain('relanzar check_suite no abre ninguna pipeline')
    expect(reason).toContain('ci-red: no cumple: conclusion eq "failure"')
  })

  it('says it with no decisions at all', () => {
    expect(noOpReason(latest, [])).toMatch(/^relanzar check_suite no abre ninguna pipeline —/)
  })
})
