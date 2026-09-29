import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { AddLabelsTool } from '../AddLabelsTool.js'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function clientWith(fetchImpl: typeof fetch) {
  return new GithubClient({ auth: new GithubTokenAuth('t'), fetchImpl })
}

describe('github_add_labels', () => {
  it('posts the labels and returns the resulting label list', async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://api.github.com/repos/o/r/issues/5/labels')
      expect(JSON.parse(init.body as string)).toEqual({ labels: ['bug'] })
      return jsonResponse([{ name: 'bug' }, { name: 'p1' }])
    })
    const tool = new AddLabelsTool(clientWith(fetchImpl as unknown as typeof fetch))

    const result = await tool.handler({ owner: 'o', repo: 'r', number: 5, labels: ['bug'] })

    expect(result).toBe('Labels actuales: bug, p1')
  })

  it('rejects a non-integer or non-positive issue number', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }))
    const tool = new AddLabelsTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(
      tool.handler({ owner: 'o', repo: 'r', number: 1.5, labels: ['bug'] }),
    ).rejects.toThrow('number')
    await expect(
      tool.handler({ owner: 'o', repo: 'r', number: -1, labels: ['bug'] }),
    ).rejects.toThrow('number')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects an empty labels array without calling GitHub', async () => {
    const fetchImpl = vi.fn(async () => new Response('[]', { status: 200 }))
    const tool = new AddLabelsTool(clientWith(fetchImpl as unknown as typeof fetch))

    await expect(tool.handler({ owner: 'o', repo: 'r', number: 5, labels: [] })).rejects.toThrow(
      /→ at labels/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
