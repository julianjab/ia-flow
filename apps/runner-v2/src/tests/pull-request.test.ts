import { describe, expect, it, vi } from 'bun:test'
import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import {
  PrChecksAction,
  ReviewPullRequestAction,
} from '../../.config/actions/_lib/github/tools/index.js'

const ctx = (payload: Record<string, unknown>): PipelineExecutionContext => ({
  event: createEvent('pull_request', payload),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'review',
})
const prEvent = {
  owner: 'la-haus',
  repo: 'subscriptions',
  pr: { number: 12, head: { sha: 'abc123' } },
}

describe('ReviewPullRequestAction', () => {
  it('posts ONE COMMENT review on the event PR, pinned to its head commit, with the reviewer header', async () => {
    const requestJson = vi.fn(async () => ({ html_url: 'https://github.com/x/pull/12#review' }))
    const action = new ReviewPullRequestAction({ requestJson } as unknown as GithubClient)
    const out = await action.run(ctx(prEvent), {
      body: 'falta un test de paginación',
      comments: [
        { path: 'core/leads.py', line: 40, body: 'esto no pagina' },
        { path: 'core/api.py', line: 3, body: '# reviewer\nya con header' },
      ],
    })
    expect(requestJson).toHaveBeenCalledTimes(1)
    const [path, init] = requestJson.mock.calls[0] as unknown as [
      string,
      { method: string; body: string },
    ]
    expect(path).toBe('/repos/la-haus/subscriptions/pulls/12/reviews')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      commit_id: 'abc123',
      event: 'COMMENT',
      body: '# reviewer\nfalta un test de paginación',
      comments: [
        { path: 'core/leads.py', line: 40, side: 'RIGHT', body: '# reviewer\nesto no pagina' },
        { path: 'core/api.py', line: 3, side: 'RIGHT', body: '# reviewer\nya con header' },
      ],
    })
    expect(out).toContain('2 comentario(s)')
  })

  it("an event without its own PR reviews the task's open PR (`task.pr`)", async () => {
    const requestJson = vi.fn(async () => ({ html_url: 'u' }))
    const action = new ReviewPullRequestAction({ requestJson } as unknown as GithubClient)
    await action.run(
      ctx({ owner: 'la-haus', repo: 'subscriptions', task: { pr: { number: 9, headSha: 'def' } } }),
      { comments: [{ path: 'a', line: 1, body: 'x' }] },
    )
    const [path, init] = requestJson.mock.calls[0] as unknown as [string, { body: string }]
    expect(path).toBe('/repos/la-haus/subscriptions/pulls/9/reviews')
    expect(JSON.parse(init.body).commit_id).toBe('def')
  })

  it('refuses to run without a PR in the event — the model never picks the PR', async () => {
    const action = new ReviewPullRequestAction({ requestJson: vi.fn() } as unknown as GithubClient)
    await expect(
      action.run(ctx({ owner: 'o', repo: 'r' }), { comments: [{ path: 'a', line: 1, body: 'x' }] }),
    ).rejects.toThrow(/no trae un PR/)
  })

  it('rejects a long body — the summary and the verdict go in the report, not in the review', async () => {
    const requestJson = vi.fn()
    const action = new ReviewPullRequestAction({ requestJson } as unknown as GithubClient)
    await expect(
      action.asTool(ctx(prEvent)).handler({ body: 'x'.repeat(1_501), comments: [] }),
    ).rejects.toThrow(/van en el `report` de tu submit_\*/)
    expect(requestJson).not.toHaveBeenCalled()
  })

  it('is a write action (an agent needs allowWrite to get it)', () => {
    expect(new ReviewPullRequestAction({} as GithubClient).sideEffects).toBe('write')
  })
})

describe('PrChecksAction', () => {
  it('lists the checks of the PR head commit with their summary', async () => {
    const requestJson = vi.fn(async () => ({
      check_runs: [
        {
          name: 'lint',
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://ci/1',
          output: { title: '2 errores', summary: 'E501 line too long' },
        },
      ],
    }))
    const out = await new PrChecksAction({ requestJson } as unknown as GithubClient).run(
      ctx(prEvent),
      {},
    )
    expect(requestJson).toHaveBeenCalledWith(
      '/repos/la-haus/subscriptions/commits/abc123/check-runs?per_page=100',
    )
    expect(out).toContain('**lint**: completed / failure')
    expect(out).toContain('E501 line too long')
    expect(new PrChecksAction({} as GithubClient).sideEffects).toBe('none')
  })
})
