import { afterEach, describe, expect, test } from 'bun:test'
import type { ExecutionLog } from '@ia-flow/shared'
import { RemoteExecutionLogRepository } from '../RemoteExecutionLogRepository.js'

function fakeEntry(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'exec-1',
    projectId: 'proj-1',
    taskId: 'task-1',
    taskTitle: 'Title',
    agentId: 'agent-1',
    providerId: 'provider-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
    ...overrides,
  }
}

describe('RemoteExecutionLogRepository', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('insert POSTs an {op: "insert", entry} body with the shared-secret header', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', 'secret')
    const entry = fakeEntry()
    repo.insert(entry)
    // fire-and-forget: give the microtask queue a tick to run the fetch call
    await new Promise((r) => setTimeout(r, 0))

    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('http://host/api/remote-executions')
    expect(calls[0].init.method).toBe('POST')
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-ia-flow-token']).toBe('secret')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ op: 'insert', entry })
  })

  test('update after a known insert POSTs the merged row as an upsert {op: "insert"}', async () => {
    const calls: Array<{ init: RequestInit }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', undefined)
    const entry = fakeEntry()
    repo.insert(entry)
    repo.update('exec-1', { outcome: 'success' })
    await new Promise((r) => setTimeout(r, 0))

    expect(calls.length).toBe(2)
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      op: 'insert',
      entry: { ...entry, outcome: 'success' },
    })
    const headers = calls[1].init.headers as Record<string, string>
    expect(headers['x-ia-flow-token']).toBeUndefined()
  })

  test('update with no known prior insert falls back to a bare {op: "update"} patch', async () => {
    const calls: Array<{ init: RequestInit }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    // No prior insert() call — e.g. this process restarted after inserting,
    // losing its in-memory cache.
    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', undefined)
    repo.update('exec-1', { outcome: 'success' })
    await new Promise((r) => setTimeout(r, 0))

    expect(calls.length).toBe(1)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      op: 'update',
      id: 'exec-1',
      patch: { outcome: 'success' },
    })
  })

  test('a second update merges onto the previous merge, not the original insert', async () => {
    const calls: Array<{ init: RequestInit }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', undefined)
    const entry = fakeEntry()
    repo.insert(entry)
    repo.update('exec-1', { outcome: 'success' })
    repo.update('exec-1', { errorMsg: 'late note' })
    await new Promise((r) => setTimeout(r, 0))

    expect(calls.length).toBe(3)
    expect(JSON.parse(calls[2].init.body as string)).toEqual({
      op: 'insert',
      entry: { ...entry, outcome: 'success', errorMsg: 'late note' },
    })
  })

  test('a rejected fetch never throws out of insert/update (fire-and-forget)', () => {
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch

    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', 'secret')
    expect(() => repo.insert(fakeEntry())).not.toThrow()
    expect(() => repo.update('exec-1', {})).not.toThrow()
  })

  test('read methods are stubs that never contact the network', () => {
    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', 'secret')
    expect(repo.list({})).toEqual([])
    expect(repo.listActive()).toEqual([])
    expect(repo.getById('exec-1')).toBeNull()
    expect(repo.sweepOrphaned('boot')).toEqual([])
    expect(repo.listDistinctSources()).toEqual([])
  })

  // The shutdown path sweeps and then exits ~200ms later — flush() is what
  // keeps that last POST from being cut off mid-flight, which would leave
  // the row open on the main daemon with nothing left to re-forward.
  test('flush() waits for the in-flight POSTs to drain', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let done = false
    globalThis.fetch = (async () => {
      await gate
      done = true
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', 'secret')
    repo.update('exec-1', { finishedAt: '2026-01-01T00:05:00.000Z', outcome: 'error' })
    expect(done).toBe(false)

    release?.()
    await repo.flush()
    expect(done).toBe(true)
  })
})
