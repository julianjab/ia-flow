import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { PostCommentAction, REPORT_MARKER } from '../PostCommentAction.js'

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 42 }

function ctxFor(payload: Record<string, unknown> = ISSUE): PipelineExecutionContext {
  return { event: createEvent('e', payload), steps: {}, bus: new EventBus(), pipelineId: 'p' }
}

function fakeGithub() {
  const calls: Array<{ url: string; body: { body: string } }> = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) })
    return new Response(JSON.stringify({ html_url: 'https://github.com/c/1' }), { status: 201 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, calls }
}

const report = { summary: 'Agregué paginación', validations: ['pnpm test: 41 ok', 'lint ok'] }

describe('PostCommentAction', () => {
  it('renders the structured report with the ia-flow marker', async () => {
    const { client, calls } = fakeGithub()

    const result = await new PostCommentAction({ client, heading: 'implementer' }).run(ctxFor(), {
      ...report,
      target: 'issue',
    })

    expect(result).toBe('Comentario publicado: https://github.com/c/1')
    expect(calls[0]?.body.body).toBe(
      [
        '### implementer',
        '**Qué hice**',
        'Agregué paginación',
        '**Validaciones**',
        '- pnpm test: 41 ok\n- lint ok',
        REPORT_MARKER,
      ].join('\n\n'),
    )
  })

  it('the marker is what claw-agents rules use to ignore pipeline comments', () => {
    const rulePattern = /^(?![\s\S]*<!-- ia-flow:)/

    expect(rulePattern.test(`hola\n\n${REPORT_MARKER}`)).toBe(false)
    expect(rulePattern.test('un comentario humano')).toBe(true)
  })

  it('says so when there were no validations', async () => {
    const { client, calls } = fakeGithub()

    await new PostCommentAction({ client }).run(ctxFor(), { summary: 's', validations: [] })

    expect(calls[0]?.body.body).toContain('**Validaciones**\n\n- (ninguna)')
  })

  it('pr-else-issue (the default) comments on the PR when the run has one', async () => {
    const { client, calls } = fakeGithub()

    await new PostCommentAction({ client }).run(ctxFor({ ...ISSUE, pr: { number: 99 } }), report)

    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/la-haus/subscriptions/issues/99/comments',
    )
  })

  it('pr-else-issue falls back to the issue without a PR', async () => {
    const { client, calls } = fakeGithub()

    await new PostCommentAction({ client }).run(ctxFor(), report)

    expect(calls[0]?.url).toBe(
      'https://api.github.com/repos/la-haus/subscriptions/issues/42/comments',
    )
  })

  it('issue ignores the PR even when there is one', async () => {
    const { client, calls } = fakeGithub()

    await new PostCommentAction({ client }).run(ctxFor({ ...ISSUE, prNumber: 99 }), {
      ...report,
      target: 'issue',
    })

    expect(calls[0]?.url).toContain('/issues/42/comments')
  })

  it('pr fails when the run has no PR', async () => {
    const { client } = fakeGithub()

    await expect(
      new PostCommentAction({ client }).run(ctxFor(), { ...report, target: 'pr' }),
    ).rejects.toThrow('target "pr" pero la corrida no tiene un PR')
  })

  it('requires validations: a report without them is rejected before posting', async () => {
    const { client, calls } = fakeGithub()

    await expect(
      new PostCommentAction({ client }).run(ctxFor(), { summary: 'hice algo' }),
    ).rejects.toThrow(/post_comment: input inválido[\s\S]*→ at validations/)
    expect(calls).toEqual([])
  })

  it('bound with a target, the model only writes the report', () => {
    const { client } = fakeGithub()
    const onIssue = new PostCommentAction({ client }).bind({ target: 'issue' })

    expect(Object.keys(onIssue.input.shape).sort()).toEqual(['summary', 'validations'])
  })
})
