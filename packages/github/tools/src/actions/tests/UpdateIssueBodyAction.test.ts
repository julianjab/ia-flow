import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { UpdateIssueBodyAction } from '../UpdateIssueBodyAction.js'

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 42 }

function ctxFor(payload: Record<string, unknown> = ISSUE): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

function fakeGithub() {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ method: init.method ?? 'GET', url, body: JSON.parse(init.body as string) })
    return new Response('{}', { status: 200 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, calls }
}

describe('UpdateIssueBodyAction', () => {
  it('replaces the body of the issue from the event', async () => {
    const { client, calls } = fakeGithub()

    const result = await new UpdateIssueBodyAction({ client }).run(ctxFor(), {
      body: '## PRD\n\nhacer X',
    })

    expect(result).toBe('Body actualizado: la-haus/subscriptions#42 (15 caracteres)')
    expect(calls).toEqual([
      {
        method: 'PATCH',
        url: 'https://api.github.com/repos/la-haus/subscriptions/issues/42',
        body: { body: '## PRD\n\nhacer X' },
      },
    ])
  })

  it('accepts and ignores the task_id ia-flow prompts ask for — the issue never comes from the model', async () => {
    const { client, calls } = fakeGithub()

    await new UpdateIssueBodyAction({ client }).run(ctxFor(), {
      body: 'x',
      task_id: 'otra-org/otro-repo#1',
    })

    expect(calls[0]?.url).toBe('https://api.github.com/repos/la-haus/subscriptions/issues/42')
    expect(calls[0]?.body).toEqual({ body: 'x' })
  })

  it('rejects an empty body without touching the issue', async () => {
    const { client, calls } = fakeGithub()

    await expect(new UpdateIssueBodyAction({ client }).run(ctxFor(), { body: '' })).rejects.toThrow(
      /update_issue_body: input inválido[\s\S]*→ at body/,
    )
    expect(calls).toEqual([])
  })

  it('writes, so it is not handed to an agent without allowWrite', () => {
    const { client } = fakeGithub()

    expect(new UpdateIssueBodyAction({ client }).sideEffects).toBe('write')
  })
})
