import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Agent,
  Condition,
  createEvent,
  type DomainEvent,
  Engine,
  EventBus,
  FunctionAction,
  PauseAction,
  Pipeline,
  ProviderRegistry,
  scopeExecutionKey,
} from '@ia-flow/agent-engine'
import { executionStoreContract } from '@ia-flow/agent-engine/testing'
import { describe, expect, it } from 'vitest'
import { openNodeSqlite } from '../node.js'
import { SqliteExecutionStore } from '../SqliteExecutionStore.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'agent-engine-sqlite-')), 'executions.db')

executionStoreContract(
  'SqliteExecutionStore',
  (options) => new SqliteExecutionStore({ database: openNodeSqlite(':memory:'), ...options }),
)

const TASK = { projectId: 'p', issue: 7 }
const event = (type: string, payload: Record<string, unknown> = {}): DomainEvent =>
  createEvent(type, payload, { scope: TASK })
const KEY = scopeExecutionKey(event('x')) as string

/** El gate de CI armado de nuevo en cada "proceso": la pipeline vive en el código, no en la base. */
function ciGate(ran: string[]) {
  const waitCi = new PauseAction({
    id: 'wait-ci',
    branches: {
      green: {
        on: ['check_suite'],
        when: [new Condition({ field: 'conclusion', op: 'eq', value: 'success' })],
        to: new FunctionAction({ id: 'review', fn: (ctx) => ran.push(`review:${ctx.event.type}`) }),
      },
    },
  })
  const implementer = new Agent(
    { id: 'implementer', provider: 'done', prompt: 'p', routes: { done: { to: waitCi } } },
    new ProviderRegistry().register({
      id: 'done',
      run: async (ctx) => {
        ran.push('implementer')
        await ctx.tools.find((tool) => tool.name === 'submit_done')?.handler({})
        return { outcome: 'success' }
      },
    }),
  )
  return new Pipeline({ id: 'build', on: ['build'], do: [implementer] })
}

describe('SqliteExecutionStore across a restart', () => {
  it('a paused execution survives the process and resumes from its checkpoint', async () => {
    const path = dbFile()
    const ran: string[] = []

    const before = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const first = new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [ciGate(ran)] },
      executions: before,
    })
    await first.dispatch(event('build'))
    const paused = before.current(KEY)
    expect(paused?.status).toBe('paused')
    before.close()

    const after = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const restored = after.current(KEY)
    expect(restored?.id).toBe(paused?.id)
    expect(restored?.pausedOn?.pauseId).toBe('wait-ci')

    const second = new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [ciGate(ran)] },
      executions: after,
    })
    expect(await second.dispatch(event('check_suite', { conclusion: 'success' }))).toBe('resumed')
    expect(ran).toEqual(['implementer', 'review:check_suite'])
    await tick()
    expect(after.current(KEY)).toBeUndefined()
    expect(after.database.find(paused?.id as string)?.status).toBe('done')
    after.close()
  })

  it('a running execution is closed as interrupted, and what it never read is handed back', async () => {
    const path = dbFile()
    const before = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const running = await before.start({ key: KEY, pipelineId: 'build' })
    running.enter(
      new Agent({ id: 'a', provider: 'p', prompt: 'p', injects: [{ on: ['comment'] }] }),
    )
    const comment = event('comment', { body: 'hola' })
    running.inject('hola', comment)
    before.close()

    const after = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    expect(after.current(KEY)).toBeUndefined()
    expect(after.takeOrphaned()).toEqual([{ executionId: running.id, events: [comment] }])
    expect(after.database.find(running.id)).toMatchObject({
      status: 'failed',
      closeReason: 'interrupted',
    })
    after.close()

    // Ya cerrada: un tercer arranque no la vuelve a entregar.
    const again = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    expect(again.takeOrphaned()).toEqual([])
    again.close()
  })

  it('never reuses an execution id after a restart', async () => {
    const path = dbFile()
    const before = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const a = await before.start({ key: 'a', pipelineId: 'p' })
    a.close('done')
    before.close()

    const after = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const b = await after.start({ key: 'b', pipelineId: 'p' })
    expect(b.id).not.toBe(a.id)
    after.close()
  })
})
