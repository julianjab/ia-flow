import type { ExecutionLog } from '@ia-flow/shared'
import axios from 'axios'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cancelExecution,
  fetchActiveExecutions,
  fetchExecutionSources,
  fetchExecutions,
} from '../api'

function makeExec(overrides: Partial<ExecutionLog> = {}): ExecutionLog {
  return {
    id: 'e1',
    projectId: 'p1',
    taskId: 't1',
    taskTitle: 'Title',
    agentId: 'agent-1',
    providerId: 'anthropic-api',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: null,
    outcome: null,
    errorMsg: null,
    stopReason: null,
    ...overrides,
  }
}

const axiosResponse = <T>(data: T) => ({
  data,
  status: 200,
  statusText: 'OK',
  headers: {},
  config: {},
})

const originalGet = axios.get
const originalPost = axios.post

afterEach(() => {
  axios.get = originalGet
  axios.post = originalPost
})

describe('executions api', () => {
  describe('fetchExecutions', () => {
    it('GETs /api/executions with the given filters and parses the array', async () => {
      const calls: Array<{ url: string; params: unknown }> = []
      axios.get = (async (url: string, config?: { params?: unknown }) => {
        calls.push({ url, params: config?.params })
        return axiosResponse({ executions: [makeExec()] })
      }) as typeof axios.get

      const result = await fetchExecutions({ taskId: 't1', limit: 10 })

      expect(calls).toEqual([{ url: '/api/executions', params: { taskId: 't1', limit: 10 } }])
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('e1')
    })

    it('throws when the server returns a payload that fails schema validation', async () => {
      axios.get = (async () =>
        axiosResponse({ executions: [{ id: 'missing-fields' }] })) as typeof axios.get
      await expect(fetchExecutions({})).rejects.toThrow()
    })
  })

  describe('fetchActiveExecutions', () => {
    it('GETs /api/executions/active', async () => {
      const calls: string[] = []
      axios.get = (async (url: string) => {
        calls.push(url)
        return axiosResponse({ executions: [makeExec({ id: 'active-1' })] })
      }) as typeof axios.get

      const result = await fetchActiveExecutions()
      expect(calls).toEqual(['/api/executions/active'])
      expect(result.map((e) => e.id)).toEqual(['active-1'])
    })
  })

  describe('fetchExecutionSources', () => {
    it('returns only string sources', async () => {
      axios.get = (async () =>
        axiosResponse({
          sources: ['subscriptions-pipeline', 42, null, 'other-daemon'],
        })) as typeof axios.get
      const result = await fetchExecutionSources()
      expect(result).toEqual(['subscriptions-pipeline', 'other-daemon'])
    })

    it('returns an empty array when sources is not an array', async () => {
      axios.get = (async () => axiosResponse({ sources: null })) as typeof axios.get
      const result = await fetchExecutionSources()
      expect(result).toEqual([])
    })
  })

  describe('cancelExecution', () => {
    it('POSTs /api/executions/:id/cancel and returns the parsed result', async () => {
      const calls: string[] = []
      axios.post = (async (url: string) => {
        calls.push(url)
        return axiosResponse({ ok: true, execution: makeExec({ outcome: 'cancelled' }) })
      }) as typeof axios.post

      const result = await cancelExecution('e1')
      expect(calls).toEqual(['/api/executions/e1/cancel'])
      expect(result).toMatchObject({ ok: true, alreadyFinished: undefined, orphaned: undefined })
      expect(result.execution.outcome).toBe('cancelled')
    })

    it('surfaces cancelRequested (advisory-only mark) when the row is owned by another daemon', async () => {
      axios.post = (async () =>
        axiosResponse({
          ok: true,
          cancelRequested: true,
          execution: makeExec({
            source: 'subscriptions-pipeline',
            cancelRequestedAt: '2026-01-01T00:05:00.000Z',
          }),
        })) as typeof axios.post

      const result = await cancelExecution('e1')
      expect(result.cancelRequested).toBe(true)
      expect(result.execution.cancelRequestedAt).toBe('2026-01-01T00:05:00.000Z')
    })

    it('surfaces alreadyFinished and orphaned flags', async () => {
      axios.post = (async () =>
        axiosResponse({
          ok: true,
          alreadyFinished: true,
          execution: makeExec(),
        })) as typeof axios.post
      expect((await cancelExecution('e1')).alreadyFinished).toBe(true)

      axios.post = (async () =>
        axiosResponse({ ok: true, orphaned: true, execution: makeExec() })) as typeof axios.post
      expect((await cancelExecution('e1')).orphaned).toBe(true)
    })
  })
})
