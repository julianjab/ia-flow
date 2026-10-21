import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import type { GithubClient } from '@ia-flow/github-api'
import { describe, expect, it, vi } from 'vitest'
import { PrChecksAction, ReviewPullRequestAction } from '../index.js'

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

  // La forma real de lh-seller-v2-frontend#4478: «SonarCloud Code Analysis» publica cada issue
  // nuevo como anotación (regla en `title`, link en `message`), y el resumen sólo trae el link.
  const sonarRun = (annotations_count: number) => ({
    id: 77,
    name: 'SonarCloud Code Analysis',
    status: 'completed',
    conclusion: 'success',
    output: { title: 'Quality Gate passed', summary: '26 New issues', annotations_count },
  })
  const sonarIssue = (line: number) => ({
    path: 'layers/crm/components/CrmAutomationsWorkspace/index.vue',
    start_line: line,
    annotation_level: 'warning',
    title: 'Prefer `.some(…)` over `.find(…)`.',
    message: '\nSee more on https://sonarcloud.io/project/issues?id=x&issues=AaFd',
  })

  it('lists the annotations of a check by file:line with the rule as the title', async () => {
    const requestJson = vi.fn(async (path: string) =>
      path.includes('/annotations')
        ? [sonarIssue(770), { ...sonarIssue(12), title: null, message: '\n  Unused import\nmore' }]
        : { check_runs: [sonarRun(2), { ...sonarRun(0), id: 78, name: 'build' }] },
    )
    const out = await new PrChecksAction({ requestJson } as unknown as GithubClient).run(
      ctx(prEvent),
      {},
    )
    // Sólo se piden para el check que las tiene (`annotations_count > 0`), en una página.
    expect(requestJson).toHaveBeenCalledWith(
      '/repos/la-haus/subscriptions/check-runs/77/annotations?per_page=50',
    )
    expect(requestJson).toHaveBeenCalledTimes(2)
    expect(out).toContain('  Anotaciones (2):')
    expect(out).toContain(
      '    - warning layers/crm/components/CrmAutomationsWorkspace/index.vue:770 — Prefer `.some(…)` over `.find(…)`.',
    )
    // Sin título, la primera línea con texto del mensaje.
    expect(out).toContain('index.vue:12 — Unused import')
    expect(out).not.toContain('… y')
  })

  it('caps the annotations per check and says how many were left out', async () => {
    const many = Array.from({ length: 60 }, (_, i) => sonarIssue(i + 1))
    const requestJson = vi.fn(async (path: string) =>
      path.includes('/annotations') ? many : { check_runs: [sonarRun(120)] },
    )
    const out = String(
      await new PrChecksAction({ requestJson } as unknown as GithubClient).run(ctx(prEvent), {}),
    )
    expect(out.match(/^ {4}- warning /gm)).toHaveLength(50)
    expect(out).toContain('… y 70 más (en el detalle del check)')
  })

  it('keeps the other checks when the annotations cannot be read', async () => {
    const requestJson = vi.fn(async (path: string) => {
      if (path.includes('/annotations')) throw new Error('GitHub 403')
      return { check_runs: [sonarRun(3), { ...sonarRun(0), id: 78, name: 'build' }] }
    })
    const out = await new PrChecksAction({ requestJson } as unknown as GithubClient).run(
      ctx(prEvent),
      {},
    )
    expect(out).toContain('Anotaciones (3): no se pudieron leer (GitHub 403)')
    expect(out).toContain('**build**: completed / success')
  })
})
