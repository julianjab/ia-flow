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

  test('update POSTs an {op: "update", id, patch} body', async () => {
    const calls: Array<{ init: RequestInit }> = []
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init })
      return new Response('{}', { status: 200 })
    }) as typeof fetch

    const repo = new RemoteExecutionLogRepository('http://host/api/remote-executions', undefined)
    repo.update('exec-1', { outcome: 'success' })
    await new Promise((r) => setTimeout(r, 0))

    expect(calls.length).toBe(1)
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      op: 'update',
      id: 'exec-1',
      patch: { outcome: 'success' },
    })
    const headers = calls[0].init.headers as Record<string, string>
    expect(headers['x-ia-flow-token']).toBeUndefined()
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
    expect(repo.sweepOrphaned('boot')).toBe(0)
    expect(repo.listDistinctSources()).toEqual([])
  })
})
