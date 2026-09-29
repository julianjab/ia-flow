import { describe, expect, it, vi } from 'bun:test'
import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-tools/agent-engine'
import type { GithubClient } from '@ia-tools/github-api'
import {
  AddSubIssueAction,
  AddToProjectAction,
  CreateGithubIssueAction,
  type GithubProjectContext,
  MarkBlockedByAction,
  ReplyPrReviewThreadAction,
  ResolvePrReviewThreadAction,
} from '../../.config/actions/_lib/github/tools/index.js'

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('task', {}),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'refine',
})

function project(
  client: Partial<Record<'requestJson' | 'graphql', unknown>>,
): GithubProjectContext {
  return {
    client: client as unknown as GithubClient,
    board: { owner: 'la-haus', number: 119 },
    repos: [
      { name: 'subscriptions' },
      { name: 'front', githubOwner: 'la-haus', githubRepo: 'lh-seller-v2-frontend' },
    ],
  }
}

const bodyOf = (call: unknown[]) => JSON.parse((call[1] as { body: string }).body)

describe('CreateGithubIssueAction', () => {
  it('creates the issue in a catalog repo and returns the ids the other tools need', async () => {
    const requestJson = vi.fn(async (_path: string, _init?: unknown) => ({
      node_id: 'I_1',
      number: 42,
      id: 9001,
    }))
    const out = await new CreateGithubIssueAction(project({ requestJson })).run(ctx(), {
      repo: 'front',
      title: 'widget',
      body: 'b',
      labels: ['frontend'],
    })
    expect(requestJson.mock.calls[0]?.[0]).toBe('/repos/la-haus/lh-seller-v2-frontend/issues')
    expect(bodyOf(requestJson.mock.calls[0] as unknown[])).toEqual({
      title: 'widget',
      body: 'b',
      labels: ['frontend'],
    })
    expect(JSON.parse(out as string)).toEqual({
      issueId: 'I_1',
      issueNumber: 42,
      numericId: 9001,
      owner: 'la-haus',
      repo: 'lh-seller-v2-frontend',
    })
  })

  it('refuses a repo the project does not declare — the model never picks an arbitrary repo', async () => {
    const requestJson = vi.fn()
    await expect(
      new CreateGithubIssueAction(project({ requestJson })).run(ctx(), {
        repo: 'otro',
        title: 't',
        body: 'b',
      }),
    ).rejects.toThrow(/no está en el catálogo/)
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('is a write action', () => {
    expect(new CreateGithubIssueAction(project({})).sideEffects).toBe('write')
  })
})

describe('AddToProjectAction', () => {
  it('resolves the board id once and adds each issue to it', async () => {
    const graphql = vi.fn(async (query: string, _vars?: unknown) =>
      query.includes('projectV2(number')
        ? { organization: { projectV2: { id: 'PVT_board' } } }
        : { addProjectV2ItemById: { item: { id: 'PVTI_new' } } },
    )
    const action = new AddToProjectAction(project({ graphql }))
    expect(JSON.parse((await action.run(ctx(), { issue_node_id: 'I_1' })) as string)).toEqual({
      itemId: 'PVTI_new',
    })
    await action.run(ctx(), { issue_node_id: 'I_2' })
    const lookups = graphql.mock.calls.filter(([q]) => q.includes('projectV2(number'))
    expect(lookups).toHaveLength(1)
    expect(graphql.mock.calls.at(-1)?.[1]).toEqual({ projectId: 'PVT_board', contentId: 'I_2' })
  })

  it('fails when the board does not exist, and retries the lookup next time', async () => {
    const graphql = vi.fn(async () => ({ organization: { projectV2: null } }))
    const action = new AddToProjectAction(project({ graphql }))
    await expect(action.run(ctx(), { issue_node_id: 'I_1' })).rejects.toThrow(
      /no se encontró el board/,
    )
    await expect(action.run(ctx(), { issue_node_id: 'I_1' })).rejects.toThrow(
      /no se encontró el board/,
    )
    expect(graphql).toHaveBeenCalledTimes(2)
  })
})

describe('AddSubIssueAction', () => {
  it('links the child under the parent issue of a catalog repo', async () => {
    const requestJson = vi.fn(async (_path: string, _init?: unknown) => ({}))
    await new AddSubIssueAction(project({ requestJson })).run(ctx(), {
      parent_repo: 'subscriptions',
      parent_issue_number: 7,
      child_numeric_id: 9001,
    })
    expect(requestJson.mock.calls[0]?.[0]).toBe('/repos/la-haus/subscriptions/issues/7/sub_issues')
    expect(bodyOf(requestJson.mock.calls[0] as unknown[])).toEqual({ sub_issue_id: 9001 })
  })
})

describe('MarkBlockedByAction', () => {
  it('creates the native dependency between the two issues', async () => {
    const graphql = vi.fn(async (_query: string, _vars?: unknown) => ({}))
    await new MarkBlockedByAction(project({ graphql })).run(ctx(), {
      blocked_issue_id: 'I_b',
      blocking_issue_id: 'I_a',
    })
    expect(graphql.mock.calls[0]?.[0]).toContain('addBlockedBy')
    expect(graphql.mock.calls[0]?.[1]).toEqual({ issueId: 'I_b', blockingIssueId: 'I_a' })
  })
})

describe('review thread actions', () => {
  it('replies inside the thread and resolves it by the id shown in task.comments', async () => {
    const graphql = vi.fn(async (_query: string, _vars?: unknown) => ({}))
    const client = { graphql } as unknown as GithubClient
    await new ReplyPrReviewThreadAction(client).run(ctx(), {
      thread_id: 'PRRT_x',
      body: 'listo en abc',
    })
    await new ResolvePrReviewThreadAction(client).run(ctx(), { thread_id: 'PRRT_x' })
    expect(graphql.mock.calls[0]?.[0]).toContain('addPullRequestReviewThreadReply')
    expect(graphql.mock.calls[0]?.[1]).toEqual({ threadId: 'PRRT_x', body: 'listo en abc' })
    expect(graphql.mock.calls[1]?.[0]).toContain('resolveReviewThread')
  })

  it('rejects anything that is not a review thread id', async () => {
    const graphql = vi.fn()
    await expect(
      new ResolvePrReviewThreadAction({ graphql } as unknown as GithubClient).run(ctx(), {
        thread_id: 'I_issue',
      }),
    ).rejects.toThrow()
    expect(graphql).not.toHaveBeenCalled()
  })
})
