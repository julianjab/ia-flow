import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import {
  CheckPrMergeableAction,
  MergePullRequestAction,
  PreconditionError,
} from '../MergePullRequestActions.js'

const ctx = (payload: Record<string, unknown> = {}): PipelineExecutionContext => ({
  event: createEvent('e', { owner: 'o', repo: 'r', number: 1, pr: { number: 12 }, ...payload }),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'p',
})

function github(pull: Record<string, unknown> = { mergeable_state: 'clean' }) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`.trim())
    return Response.json(url.endsWith('/merge') ? { merged: true } : pull)
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, calls }
}

describe('CheckPrMergeableAction', () => {
  it('passes a clean PR and one that only fails non-required checks (unstable)', async () => {
    for (const state of ['clean', 'unstable', 'has_hooks']) {
      const { client } = github({ mergeable_state: state })
      await expect(new CheckPrMergeableAction({ client }).run(ctx())).resolves.toContain(state)
    }
  })

  it.each([
    [{ mergeable_state: 'dirty' }, /conflictos con la rama base \(dirty\)/],
    [{ mergeable_state: 'blocked' }, /checks o reviews requeridos/],
    [{ mergeable_state: 'behind' }, /desactualizado/],
    [{ mergeable_state: 'clean', draft: true }, /borrador \(draft\)/],
    [{}, /todavía está calculando \(unknown\)|reintentá/],
  ])('refuses %j with a 409 that says why', async (pull, message) => {
    const { client } = github(pull)
    const error = await new CheckPrMergeableAction({ client })
      .run(ctx())
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(PreconditionError)
    expect((error as PreconditionError).status).toBe(409)
    expect((error as Error).message).toMatch(message)
  })

  it('refuses a task with no open PR before asking GitHub', async () => {
    const { client, calls } = github()
    await expect(
      new CheckPrMergeableAction({ client }).run(ctx({ pr: undefined })),
    ).rejects.toMatchObject({ status: 409 })
    expect(calls).toEqual([])
  })
})

describe('MergePullRequestAction', () => {
  it('merges the PR with the method asked for, squash by default', async () => {
    const { client, calls } = github()
    await new MergePullRequestAction({ client }).run(ctx())
    await new MergePullRequestAction({ client }).run(ctx(), { method: 'rebase' })
    expect(calls).toEqual([
      'PUT https://api.github.com/repos/o/r/pulls/12/merge {"merge_method":"squash"}',
      'PUT https://api.github.com/repos/o/r/pulls/12/merge {"merge_method":"rebase"}',
    ])
  })
})
