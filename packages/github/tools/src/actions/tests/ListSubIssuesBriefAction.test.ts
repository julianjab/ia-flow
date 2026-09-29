import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { ListSubIssuesBriefAction } from '../ListSubIssuesBriefAction.js'

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 42 }

function ctxFor(payload: Record<string, unknown> = ISSUE): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

function subIssue(number: number) {
  return {
    number,
    title: `hijo ${number}`,
    state: 'open',
    html_url: `https://github.com/la-haus/x/issues/${number}`,
    body: 'un body enorme que NO tiene que llegar al modelo',
  }
}

function clientWith(pages: unknown[]) {
  const urls: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(url)
    const page = pages.shift()
    return new Response(JSON.stringify(page ?? []), { status: 200 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, urls }
}

describe('ListSubIssuesBriefAction', () => {
  it('lists number, title, state and url — without bodies', async () => {
    const { client, urls } = clientWith([[subIssue(7), subIssue(8)]])

    const result = JSON.parse(
      await new ListSubIssuesBriefAction({ client }).run(ctxFor(), {
        repo: 'subscriptions',
        parent_issue_number: 42,
      }),
    )

    expect(result).toEqual({
      count: 2,
      subIssues: [
        { number: 7, title: 'hijo 7', state: 'open', url: 'https://github.com/la-haus/x/issues/7' },
        { number: 8, title: 'hijo 8', state: 'open', url: 'https://github.com/la-haus/x/issues/8' },
      ],
    })
    expect(urls).toEqual([
      'https://api.github.com/repos/la-haus/subscriptions/issues/42/sub_issues?per_page=100&page=1',
    ])
  })

  it('follows pages until one comes back short', async () => {
    const full = Array.from({ length: 100 }, (_, i) => subIssue(i + 1))
    const { client, urls } = clientWith([full, [subIssue(101)]])

    const result = JSON.parse(
      await new ListSubIssuesBriefAction({ client }).run(ctxFor(), {
        repo: 'subscriptions',
        parent_issue_number: 42,
      }),
    )

    expect(result.count).toBe(101)
    expect(urls[1]).toContain('page=2')
  })

  it('an empty list is a real "no sub-issues"', async () => {
    const { client } = clientWith([[]])

    const result = JSON.parse(
      await new ListSubIssuesBriefAction({ client }).run(ctxFor(), {
        repo: 'subscriptions',
        parent_issue_number: 42,
      }),
    )

    expect(result).toEqual({ count: 0, subIssues: [] })
  })

  it('throws instead of answering [] when GitHub returns something that is not a list', async () => {
    const { client } = clientWith([{ message: 'preview retirado' }])

    await expect(
      new ListSubIssuesBriefAction({ client }).run(ctxFor(), {
        repo: 'subscriptions',
        parent_issue_number: 42,
      }),
    ).rejects.toThrow('sub_issues de #42 (página 1) no devolvió una lista')
  })

  it('the owner comes from the event, and a traversal in repo is rejected', async () => {
    const { client, urls } = clientWith([[]])

    await expect(
      new ListSubIssuesBriefAction({ client }).run(ctxFor(), {
        repo: '../../orgs/otra',
        parent_issue_number: 1,
      }),
    ).rejects.toThrow('"repo" inválido')
    expect(urls).toEqual([])
  })

  it('only reads, so an agent can receive it without allowWrite', () => {
    const { client } = clientWith([])

    expect(new ListSubIssuesBriefAction({ client }).sideEffects).toBe('none')
  })
})
