import { describe, expect, it } from 'bun:test'
import { createEvent, InMemoryExecutionStore, scopeExecutionKey } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import type { ProjectConfig } from '../config/RunnerConfig.js'
import { DEFAULT_WORKING_MARKER, taskOfKey, trackWorking } from '../working/workingMarker.js'

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

  it('marks the card while the execution runs and clears it when it closes, in order', async () => {
    const store = new InMemoryExecutionStore()
    const { client, writes } = github()
    const lines: string[] = []
    trackWorking(store, [project(DEFAULT_WORKING_MARKER)], client, (line) => lines.push(line))

    const execution = await store.start({ key: KEY, pipelineId: 'build' })
    await execution.run(async () => undefined)
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
    trackWorking(store, [project(null)], client, () => {})
    const execution = await store.start({ key: KEY, pipelineId: 'build' })
    await execution.run(async () => undefined)
    await tick()
    expect(writes).toEqual([])
  })

  it('a failed write is logged, not thrown into the run', async () => {
    const store = new InMemoryExecutionStore()
    const lines: string[] = []
    const failing = {
      graphql: async () => {
        throw new Error('401')
      },
    } as unknown as GithubClient
    trackWorking(store, [project(DEFAULT_WORKING_MARKER)], failing, (line) => lines.push(line))
    const execution = await store.start({ key: KEY, pipelineId: 'build' })
    await execution.run(async () => undefined)
    await tick()
    expect(lines[0]).toContain('no se pudo marcar — 401')
  })
})
