import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { describe, expect, it, vi } from 'vitest'
import {
  APPROVAL_MARKER,
  ApprovePullRequestAction,
  DismissPullRequestApprovalAction,
  RequestChangesPullRequestAction,
} from '../index.js'

const ctx = (payload: Record<string, unknown>): PipelineExecutionContext => ({
  event: createEvent('issue.status_changed', payload),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'review',
})
/** La card que llega a Review: el intake trae el PR abierto de la task en `pr.*`. */
const reviewEvent = {
  owner: 'la-haus',
  repo: 'subscriptions',
  pr: { number: 12, head: { sha: 'abc1234567' } },
}

type Call = [string, { method?: string; body?: string }?]

/** El `GET` del PR (su head al aprobar) y después el `POST` del review. */
const atHead = (sha = 'abc1234567') => ({ head: { sha } })

describe('ApprovePullRequestAction', () => {
  it('posts an APPROVE review on the event PR, pinned to the commit the gate saw, with the marker', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce(atHead())
      .mockResolvedValueOnce({ html_url: 'https://github.com/x/pull/12#review' })
    const action = new ApprovePullRequestAction({ requestJson } as unknown as GithubClient)
    const out = await action.run(ctx(reviewEvent), {})
    expect(requestJson.mock.calls[0]?.[0]).toBe('/repos/la-haus/subscriptions/pulls/12')
    const [path, init] = requestJson.mock.calls[1] as unknown as [
      string,
      { method: string; body: string },
    ]
    expect(path).toBe('/repos/la-haus/subscriptions/pulls/12/reviews')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      commit_id: 'abc1234567',
      event: 'APPROVE',
      body: `Aprobado por el gate de ia-flow.\n\n${APPROVAL_MARKER}`,
    })
    expect(out).toContain('PR #12 aprobado sobre abc1234')
  })

  it('takes the body from the step (`with.body`)', async () => {
    const requestJson = vi.fn().mockResolvedValueOnce(atHead()).mockResolvedValueOnce({})
    const action = new ApprovePullRequestAction({ requestJson } as unknown as GithubClient)
    await action.run(ctx(reviewEvent), { body: 'Reviewer y e2e aprobaron.' })
    const [, init] = requestJson.mock.calls[1] as unknown as [string, { body: string }]
    expect(JSON.parse(init.body).body).toBe(`Reviewer y e2e aprobaron.\n\n${APPROVAL_MARKER}`)
  })

  it("does not throw on the App's own PR (GitHub's 422): it reports it and the gate goes on", async () => {
    const own = new Error(
      'GithubClient: GitHub API → 422: {"message":"Unprocessable Entity","errors":["Review Can not approve your own pull request"]}',
    )
    const requestJson = vi.fn().mockResolvedValueOnce(atHead()).mockRejectedValueOnce(own)
    const action = new ApprovePullRequestAction({ requestJson } as unknown as GithubClient)
    await expect(action.run(ctx(reviewEvent), {})).resolves.toMatch(/lo abrió la misma App/)
  })

  it('rethrows any other error', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce(atHead())
      .mockRejectedValueOnce(new Error('GitHub API → 403: forbidden'))
    const action = new ApprovePullRequestAction({ requestJson } as unknown as GithubClient)
    await expect(action.run(ctx(reviewEvent), {})).rejects.toThrow(/403/)
  })

  it('does not approve when the PR moved past the commit the gate reviewed (a push during the gate)', async () => {
    const requestJson = vi.fn().mockResolvedValueOnce(atHead('fff9999999'))
    const action = new ApprovePullRequestAction({ requestJson } as unknown as GithubClient)
    await expect(action.run(ctx(reviewEvent), {})).resolves.toMatch(
      /revisó abc1234 y el PR ya está en fff9999/,
    )
    expect(requestJson).toHaveBeenCalledTimes(1)
  })

  it('refuses to run without a PR in the event', async () => {
    const action = new ApprovePullRequestAction({ requestJson: vi.fn() } as unknown as GithubClient)
    await expect(action.run(ctx({ owner: 'o', repo: 'r' }), {})).rejects.toThrow(/no trae un PR/)
  })

  it('is a write action', () => {
    expect(new ApprovePullRequestAction({} as GithubClient).sideEffects).toBe('write')
  })
})

describe('RequestChangesPullRequestAction', () => {
  it('posts a REQUEST_CHANGES review on the event PR, pinned to the reviewed commit, with the marker', async () => {
    const requestJson = vi.fn(async () => ({ html_url: 'u' }))
    const action = new RequestChangesPullRequestAction({ requestJson } as unknown as GithubClient)
    const out = await action.run(ctx(reviewEvent), { body: 'El e2e no pasó.' })
    const [path, init] = requestJson.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ]
    expect(path).toBe('/repos/la-haus/subscriptions/pulls/12/reviews')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      commit_id: 'abc1234567',
      event: 'REQUEST_CHANGES',
      body: `El e2e no pasó.\n\n${APPROVAL_MARKER}`,
    })
    expect(out).toContain('cambios pedidos sobre abc1234')
  })

  it("does not throw on the App's own PR (GitHub's 422)", async () => {
    const own = new Error(
      'GithubClient: GitHub API → 422: {"errors":["Review Can not request changes on your own pull request"]}',
    )
    const requestJson = vi.fn().mockRejectedValueOnce(own)
    const action = new RequestChangesPullRequestAction({ requestJson } as unknown as GithubClient)
    await expect(action.run(ctx(reviewEvent), {})).resolves.toMatch(/lo abrió la misma App/)
  })

  it('rethrows any other error, and is a write action', async () => {
    const requestJson = vi.fn().mockRejectedValueOnce(new Error('GitHub API → 403: forbidden'))
    const action = new RequestChangesPullRequestAction({ requestJson } as unknown as GithubClient)
    await expect(action.run(ctx(reviewEvent), {})).rejects.toThrow(/403/)
    expect(action.sideEffects).toBe('write')
  })
})

describe('DismissPullRequestApprovalAction', () => {
  it('also lifts a still-standing ia-flow change request', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 6, state: 'CHANGES_REQUESTED', body: `no pasa\n\n${APPROVAL_MARKER}` },
        { id: 7, state: 'CHANGES_REQUESTED', body: 'cambiá esto' },
      ])
      .mockResolvedValue({})
    const action = new DismissPullRequestApprovalAction({ requestJson } as unknown as GithubClient)
    await expect(action.run(ctx(reviewEvent), {})).resolves.toContain('retiré 1 veredicto')
    const calls = requestJson.mock.calls as unknown as Call[]
    expect(calls.map(([path, init]) => `${init?.method ?? 'GET'} ${path}`)).toEqual([
      'GET /repos/la-haus/subscriptions/pulls/12/reviews?per_page=100',
      'PUT /repos/la-haus/subscriptions/pulls/12/reviews/6/dismissals',
    ])
  })

  it('dismisses only the still-approved ia-flow reviews (the marker), leaving humans alone', async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 1, state: 'APPROVED', body: `ok\n\n${APPROVAL_MARKER}` },
        { id: 2, state: 'APPROVED', body: 'LGTM' },
        { id: 3, state: 'DISMISSED', body: `viejo\n\n${APPROVAL_MARKER}` },
        { id: 4, state: 'COMMENTED', body: '# reviewer\nalgo' },
        { id: 5, state: 'APPROVED', body: null },
      ])
      .mockResolvedValue({})
    const action = new DismissPullRequestApprovalAction({ requestJson } as unknown as GithubClient)
    const out = await action.run(ctx(reviewEvent), {})
    const calls = requestJson.mock.calls as unknown as Call[]
    expect(calls.map(([path, init]) => `${init?.method ?? 'GET'} ${path}`)).toEqual([
      'GET /repos/la-haus/subscriptions/pulls/12/reviews?per_page=100',
      'PUT /repos/la-haus/subscriptions/pulls/12/reviews/1/dismissals',
    ])
    expect(JSON.parse(calls[1]?.[1]?.body ?? '{}')).toMatchObject({ event: 'DISMISS' })
    expect(out).toContain('retiré 1 veredicto')
  })

  it('is a no-op without ia-flow approvals', async () => {
    const requestJson = vi.fn().mockResolvedValueOnce([{ id: 2, state: 'APPROVED', body: 'LGTM' }])
    const action = new DismissPullRequestApprovalAction({ requestJson } as unknown as GithubClient)
    await expect(action.run(ctx(reviewEvent), {})).resolves.toContain('sin veredictos')
    expect(requestJson).toHaveBeenCalledTimes(1)
  })
})
