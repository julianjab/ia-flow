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

  it('an agent waiting mid-turn keeps its conversation across a restart and resumes it', async () => {
    const path = dbFile()
    const seen: unknown[] = []
    const waiter = (step: 'wait' | 'done') =>
      new Pipeline({
        id: 'build',
        on: ['build'],
        do: [
          new Agent(
            { id: 'implementer', provider: 'p', prompt: 'p', waits: { on: ['check_suite'] } },
            new ProviderRegistry().register({
              id: 'p',
              run: async (ctx) => {
                seen.push(ctx.resume)
                const tool = step === 'wait' ? 'wait_for_event' : 'submit_done'
                const input = step === 'wait' ? { on: ['check_suite'], reason: 'CI' } : {}
                await ctx.tools.find((candidate) => candidate.name === tool)?.handler(input)
                return { outcome: 'success', conversation: [{ role: 'user', content: 'hola' }] }
              },
            }),
          ),
        ],
      })

    const before = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    await new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [waiter('wait')] },
      executions: before,
    }).dispatch(event('build'))
    before.close()

    const after = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const second = new Engine({
      bus: new EventBus(),
      pipelines: { list: () => [waiter('done')] },
      executions: after,
    })
    expect(await second.dispatch(event('check_suite', { conclusion: 'success' }))).toBe('resumed')
    expect(seen[1]).toMatchObject({ conversation: [{ role: 'user', content: 'hola' }] })
    after.close()
  })

  it('a running agent that saved its conversation is resumed after a restart', async () => {
    const path = dbFile()
    const before = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const running = await before.start({ key: KEY, pipelineId: 'build' })
    running.progress({
      pipelineId: 'build',
      pauseId: 'implementer',
      resumeAt: 1,
      steps: {},
      shape: 'implementer',
      state: [{ role: 'user', content: 'hola' }],
      savedAt: new Date().toISOString(),
    })
    before.close()

    const after = new SqliteExecutionStore({ database: openNodeSqlite(path) })
    const restored = after.current(KEY)
    expect(restored?.id).toBe(running.id)
    expect(restored?.status).toBe('paused')
    expect(restored?.expired(Date.now())).toBe(true)
    expect(after.database.find(running.id)?.checkpoint).toMatchObject({
      state: [{ role: 'user', content: 'hola' }],
      attempts: 1,
    })
    after.close()
  })
})
