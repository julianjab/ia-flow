import { createEvent, EventBus, type PipelineExecutionContext } from '@ia-flow/agent-engine'
import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { REPORT_MARKER } from '../PostCommentAction.js'
import { PostUserCommentAction } from '../PostUserCommentAction.js'

const ISSUE = { owner: 'la-haus', repo: 'subscriptions', number: 42 }

const ctx = (): PipelineExecutionContext => ({
  event: createEvent('e', ISSUE),
  steps: {},
  bus: new EventBus(),
  pipelineId: 'p',
})

function fakeGithub() {
  const calls: Array<{ url: string; auth: string | null; body: { body: string } }> = []
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({
      url,
      auth: new Headers(init.headers).get('authorization'),
      body: JSON.parse(init.body as string),
    })
    return new Response(JSON.stringify({ html_url: 'https://github.com/c/1' }), { status: 201 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('gho_person'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { client, calls }
}

describe('PostUserCommentAction', () => {
  it("posts the person's text as is, with their token, and without the engine marker", async () => {
    const { client, calls } = fakeGithub()

    const result = await new PostUserCommentAction({ client }).run(ctx(), {
      body: 'Sólo upgrades.',
    })

    expect(result).toBe('Comentario publicado: https://github.com/c/1')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain('/repos/la-haus/subscriptions/issues/42/comments')
    expect(calls[0]?.auth).toBe('Bearer gho_person')
    expect(calls[0]?.body.body).toBe('Sólo upgrades.')
    expect(calls[0]?.body.body).not.toContain(REPORT_MARKER)
  })

  it('rejects an empty comment before calling GitHub', async () => {
    const { client, calls } = fakeGithub()
    await expect(new PostUserCommentAction({ client }).run(ctx(), { body: '   ' })).rejects.toThrow(
      /input inválido/,
    )
    expect(calls).toEqual([])
  })
})
