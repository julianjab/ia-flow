import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { CommentIssueTool } from '../CommentIssueTool.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(fetchImpl: typeof fetch) {
  return new GithubClient({ auth: new GithubTokenAuth('t'), fetchImpl })
}

describe('github_comment_issue', () => {
  it('posts the comment body and returns the comment URL', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.github.com/repos/o/r/issues/5/comments')
      expect(JSON.parse(init.body as string)).toEqual({ body: 'nice work' })
      return jsonResponse({ id: 1, html_url: 'https://github.com/o/r/issues/5#comment-1' })
    })
    const tool = new CommentIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    const result = await tool.handler({ owner: 'o', repo: 'r', number: 5, body: 'nice work' })

    expect(result).toBe('Comentario publicado: https://github.com/o/r/issues/5#comment-1')
  })

  it('rejects an owner containing a slash (path segment injection)', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const tool = new CommentIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(
      tool.handler({ owner: 'o/extra', repo: 'r', number: 1, body: 'x' }),
    ).rejects.toThrow('owner')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects a missing body without posting a comment', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const tool = new CommentIssueTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(tool.handler({ owner: 'o', repo: 'r', number: 5 })).rejects.toThrow(
      /github_comment_issue: input inválido[\s\S]*→ at body/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
