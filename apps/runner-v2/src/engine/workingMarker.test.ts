import { describe, expect, it } from 'bun:test'
import {
  type Checkpoint,
  createEvent,
  InMemoryExecutionStore,
  scopeExecutionKey,
} from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { createBoards } from '../board/createBoards.js'
import type { ProjectConfig } from '../config/RunnerConfig.js'
import {
  DEFAULT_WORKING_MARKER,
  type ScheduleTimer,
  taskOfKey,
  trackWorking,
} from './workingMarker.js'

const SCOPE = { projectId: 'p1', repo: 'la-haus/subscriptions', issue: 'la-haus/subscriptions#7' }
const KEY = scopeExecutionKey(createEvent('x', {}, { scope: SCOPE })) as string
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** GitHub de mentira: registra qué mutation se hizo con qué campo. */
function github() {
  const writes: string[] = []
  const client = {
    graphql: async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('projectItems')) {
        return {
          repository: {
            issue: {
              projectItems: {
                nodes: [
                  { id: 'ITEM', project: { id: 'P', number: 119, owner: { login: 'la-haus' } } },
                ],
              },
            },
          },
        }
      }
      if (query.includes('fields(')) {
        return {
          node: {
            fields: {
              nodes: [{ id: 'F_W', name: 'Working', options: [{ id: 'O_YES', name: 'Yes' }] }],
            },
          },
        }
      }
      writes.push(
        query.includes('clearProjectV2')
          ? `clear ${variables.fieldId}`
          : `set ${variables.optionId}`,
      )
      return {}
    },
  } as unknown as GithubClient
  return { client, writes }
}

/** Un reloj a mano: lo programado corre recién con `fire()`. */
function timers() {
  const due = new Map<number, () => void>()
  let next = 0
  const schedule: ScheduleTimer = (run) => {
    const id = next++
    due.set(id, run)
    return () => due.delete(id)
  }
  const fire = () => {
    const runs = [...due.values()]
    due.clear()
    for (const run of runs) run()
  }
  return { schedule, fire, pending: () => due.size }
}

const project = (workingMarker: ProjectConfig['workingMarker']) =>
  ({ id: 'p1', board: { owner: 'la-haus', number: 119 }, workingMarker }) as ProjectConfig

describe('workingMarker', () => {
  it('reads the task out of the execution key', () => {
    expect(taskOfKey(KEY)).toEqual({
      projectId: 'p1',
      owner: 'la-haus',
      repo: 'subscriptions',
      number: 7,
    })
    expect(taskOfKey('no-json')).toBeUndefined()
  })

  it('a task that is only a PR has no card to mark', () => {
    const pr = JSON.stringify([
      ['projectId', 'p1'],
      ['repo', 'la-haus/subscriptions'],
      ['issue', 'la-haus/subscriptions#12'],
      ['kind', 'pr'],
    ])
    expect(taskOfKey(pr)).toBeUndefined()
  })

  it('marks the card once the execution has run for a while and clears it when it closes, in order', async () => {
    const store = new InMemoryExecutionStore()
    const { client, writes } = github()
    const lines: string[] = []
    const clock = timers()
    const p1 = project(DEFAULT_WORKING_MARKER)
    trackWorking(store, [p1], client, createBoards([p1], client), (line) => lines.push(line), {
      schedule: clock.schedule,
    })

    const execution = await store.start({ key: KEY, pipelineId: 'build' })
    await execution.run(async () => {
      clock.fire()
      await tick()
    })
    await tick()

    expect(writes).toEqual(['set O_YES', 'clear F_W'])
    expect(lines).toEqual([
      '[working] la-haus/subscriptions#7: Yes (running)',
      '[working] la-haus/subscriptions#7: ∅ (done)',
    ])
  })

  it('does nothing when the project turns the marker off (workingMarker: null)', async () => {
    const store = new InMemoryExecutionStore()
    const { client, writes } = github()
    const p1 = project(null)
    trackWorking(store, [p1], client, createBoards([p1], client), () => {}, { delayMs: 0 })
    const execution = await store.start({ key: KEY, pipelineId: 'build' })
    await execution.run(async () => tick())
    await tick()
    expect(writes).toEqual([])
  })

  it('a short execution that closes before the delay writes nothing', async () => {
    const store = new InMemoryExecutionStore()
    const { client, writes } = github()
    const clock = timers()
    const p1 = project(DEFAULT_WORKING_MARKER)
    trackWorking(store, [p1], client, createBoards([p1], client), () => {}, {
      schedule: clock.schedule,
    })

    const execution = await store.start({ key: KEY, pipelineId: 'epic-child-review' })
    await execution.run(async () => undefined)
    clock.fire()
    await tick()

    expect(writes).toEqual([])
    expect(clock.pending()).toBe(0)
  })

  it('marks once per execution, although its record is saved as running again and again', async () => {
    const store = new InMemoryExecutionStore()
    const { client, writes } = github()
    const clock = timers()
    const p1 = project(DEFAULT_WORKING_MARKER)
    trackWorking(store, [p1], client, createBoards([p1], client), () => {}, {
      schedule: clock.schedule,
    })

    const execution = await store.start({ key: KEY, pipelineId: 'build' })
    await execution.run(async () => {
      clock.fire()
      await tick()
      // Lo que hace un agente en cada vuelta: guarda su progreso, el registro sigue `running`.
      execution.progress({ resumeAt: 0 } as unknown as Checkpoint)
      execution.progress({ resumeAt: 1 } as unknown as Checkpoint)
      clock.fire()
      await tick()
    })
    await tick()

    expect(writes).toEqual(['set O_YES', 'clear F_W'])
  })

  it('a failed write is logged, not thrown into the run', async () => {
    const store = new InMemoryExecutionStore()
    const lines: string[] = []
    const failing = {
      graphql: async () => {
        throw new Error('401')
      },
    } as unknown as GithubClient
    const p1 = project(DEFAULT_WORKING_MARKER)
    trackWorking(store, [p1], failing, createBoards([p1], failing), (line) => lines.push(line), {
      delayMs: 0,
    })
    const execution = await store.start({ key: KEY, pipelineId: 'build' })
    await execution.run(async () => tick())
    await tick()
    expect(lines[0]).toContain('no se pudo marcar — 401')
  })
})
