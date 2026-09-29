import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { closesIssue, EnsurePullRequestAction } from '../EnsurePullRequestAction.js'

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 1640 }
const TASK = { ...ISSUE, task: { branch: 'ia-flow-local/1640' } }

function ctxFor(payload: Record<string, unknown> = TASK): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

interface Call {
  method: string
  path: string
  body?: Record<string, unknown>
}

interface FakePr {
  body: string | null
  state?: 'open' | 'closed'
  merged_at?: string | null
}

/** Un GitHub falso por ruta REST: los PRs de la rama (cualquier estado), el compare contra la
 *  base, el repo y el issue. */
function fakeGithub(options: { pr?: FakePr; compareStatus?: number; aheadBy?: number } = {}) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url)
    const method = init.method ?? 'GET'
    calls.push({
      method,
      path: pathname + search,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    })
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

    if (method === 'GET' && pathname.endsWith('/pulls')) {
      const pr = options.pr
      return json(
        pr
          ? [{ number: 1642, html_url: 'https://github.com/x/pull/1642', state: 'open', ...pr }]
          : [],
      )
    }
    if (pathname.includes('/compare/')) {
      return json({ ahead_by: options.aheadBy ?? 2 }, options.compareStatus ?? 200)
    }
    if (method === 'POST' && pathname.endsWith('/pulls')) {
      return json({ number: 1700, html_url: 'https://github.com/x/pull/1700', body: '' }, 201)
    }
    if (pathname.endsWith('/issues/1640')) return json({ title: 'Bloquear reasignación' })
    if (pathname.endsWith('/subscriptions')) return json({ default_branch: 'main' })
    return json({})
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, calls, writes: () => calls.filter((c) => c.method !== 'GET') }
}

describe('EnsurePullRequestAction', () => {
  it('looks up every PR of the task branch, whatever its state', async () => {
    const { client, calls } = fakeGithub({ pr: { body: 'Closes #1640' } })
    await new EnsurePullRequestAction({ client }).run(ctxFor(), {})
    expect(calls[0]?.path).toBe(
      '/repos/la-haus/subscriptions/pulls?state=all&head=la-haus%3Aia-flow-local%2F1640',
    )
  })

  it('leaves a PR that already closes the issue untouched', async () => {
    const { client, writes } = fakeGithub({ pr: { body: 'Arregla todo.\n\nFixes #1640' } })

    const result = await new EnsurePullRequestAction({ client }).run(ctxFor(), {})

    expect(writes()).toEqual([])
    expect(result).toContain('ya cierra #1640')
  })

  it('appends Closes #n to a PR body that does not close the issue, keeping the rest', async () => {
    const { client, writes } = fakeGithub({ pr: { body: 'Descripción del modelo.\n' } })

    const result = await new EnsurePullRequestAction({ client }).run(ctxFor(), {})

    expect(writes()).toEqual([
      {
        method: 'PATCH',
        path: '/repos/la-haus/subscriptions/pulls/1642',
        body: { body: 'Descripción del modelo.\n\nCloses #1640' },
      },
    ])
    expect(result).toContain('agregado "Closes #1640"')
  })

  it('writes just Closes #n on an empty PR body', async () => {
    const { client, writes } = fakeGithub({ pr: { body: null } })
    await new EnsurePullRequestAction({ client }).run(ctxFor(), {})
    expect(writes()[0]?.body).toEqual({ body: 'Closes #1640' })
  })

  it('opens the PR when the branch has its own commits but no PR', async () => {
    const { client, calls, writes } = fakeGithub()

    const result = await new EnsurePullRequestAction({ client }).run(ctxFor(), {})

    expect(calls.map((c) => c.path)).toContain(
      '/repos/la-haus/subscriptions/compare/main...ia-flow-local%2F1640',
    )
    expect(writes()).toEqual([
      {
        method: 'POST',
        path: '/repos/la-haus/subscriptions/pulls',
        body: {
          title: 'Bloquear reasignación',
          head: 'ia-flow-local/1640',
          base: 'main',
          body: 'Closes #1640',
        },
      },
    ])
    expect(result).toContain('PR #1700 abierto')
  })

  it('fails when the branch is not on the remote', async () => {
    const { client, writes } = fakeGithub({ compareStatus: 404 })
    await expect(new EnsurePullRequestAction({ client }).run(ctxFor(), {})).rejects.toThrow(
      /no está en la-haus\/subscriptions/,
    )
    expect(writes()).toEqual([])
  })

  it('fails when the branch exists but has no commits of its own (link_branch created it)', async () => {
    const { client, writes } = fakeGithub({ aheadBy: 0 })
    await expect(new EnsurePullRequestAction({ client }).run(ctxFor(), {})).rejects.toThrow(
      /no tiene commits por delante de main/,
    )
    expect(writes()).toEqual([])
  })

  it('fails on any other error comparing the branch', async () => {
    const { client } = fakeGithub({ compareStatus: 500 })
    await expect(new EnsurePullRequestAction({ client }).run(ctxFor(), {})).rejects.toThrow(/→ 500/)
  })

  it('never opens a second PR for a branch whose PR was merged or closed', async () => {
    for (const [pr, how] of [
      [{ body: 'Closes #1640', state: 'closed', merged_at: '2026-09-25T00:00:00Z' }, 'se mergeó'],
      [{ body: 'Closes #1640', state: 'closed', merged_at: null }, 'se cerró sin mergear'],
    ] as const) {
      const { client, writes } = fakeGithub({ pr })
      await expect(new EnsurePullRequestAction({ client }).run(ctxFor(), {})).rejects.toThrow(
        new RegExp(`PR #1642 de ia-flow-local/1640 ${how}`),
      )
      expect(writes()).toEqual([])
    }
  })

  it('takes the issue and branch from the event, never from the model', async () => {
    const { client, calls } = fakeGithub()
    const action = new EnsurePullRequestAction({ client })
    await expect(action.run(ctxFor({ ...ISSUE }), {})).rejects.toThrow(/task\.branch/)
    await expect(action.run(ctxFor(), { head: 'main' } as never)).rejects.toThrow()
    expect(calls).toEqual([])
  })
})

describe('closesIssue', () => {
  it('recognises the closing keywords GitHub does, short and cross-repo', () => {
    for (const body of [
      'Closes #1640',
      'fixes #1640',
      'Resolved #1640',
      'close la-haus/subscriptions#1640',
    ]) {
      expect(closesIssue(body, ISSUE), body).toBe(true)
    }
    for (const body of ['Refs #1640', 'Closes #16400', 'Closes other/repo#1640', '#1640']) {
      expect(closesIssue(body, ISSUE), body).toBe(false)
    }
  })
})
