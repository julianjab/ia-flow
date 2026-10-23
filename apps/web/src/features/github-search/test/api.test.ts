import { describe, expect, it, vi } from 'vitest'
import { createGithubSearchApi, GithubApiError } from '@/features/github-search/api'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const issueBody = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Etapa configurable',
  html_url: 'https://github.com/acme/api/issues/7',
  state: 'open',
  updated_at: '2026-10-01T10:00:00Z',
  repository_url: 'https://api.github.com/repos/acme/api',
  ...over,
})

describe('createGithubSearchApi', () => {
  it('busca issues por título con el token, y los convierte', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        items: [issueBody(), issueBody({ number: 9, state: 'closed', pull_request: { url: 'x' } })],
      }),
    )
    const found = await createGithubSearchApi('tok', fetchImpl).search('etapa', 'acme', null)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('https://api.github.com/search/issues?')
    expect(new URL(url).searchParams.get('q')).toBe('etapa org:acme in:title is:issue')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
    expect(found).toEqual([
      {
        ref: 'acme/api#7',
        title: 'Etapa configurable',
        url: 'https://github.com/acme/api/issues/7',
        open: true,
        isPR: false,
        updatedAt: '2026-10-01T10:00:00Z',
      },
      expect.objectContaining({ ref: 'acme/api#9', open: false, isPR: true }),
    ])
  })

  it('en un repo, el scope es ese repo', async () => {
    const fetchImpl = vi.fn(async () => json({ items: [] }))
    await createGithubSearchApi('tok', fetchImpl).search('etapa', 'acme', 'api')
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0]
    expect(new URL(url).searchParams.get('q')).toBe('etapa repo:acme/api in:title is:issue')
  })

  it('los repos: sin archivados, página a página hasta una incompleta', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ name: `r${i}`, archived: i === 0 }))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(full))
      .mockResolvedValueOnce(json([{ name: 'ultimo', archived: false }]))
    const names = await createGithubSearchApi('tok', fetchImpl).repos('acme')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(names).toHaveLength(100)
    expect(names[0]).toBe('r1')
    expect(names.at(-1)).toBe('ultimo')
  })

  it('un issue por su ref; un 404 es null y otro error se lanza con el mensaje de GitHub', async () => {
    const ok = vi.fn(async () => json(issueBody()))
    expect((await createGithubSearchApi('t', ok).issue('acme/api#7'))?.ref).toBe('acme/api#7')
    expect((ok.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://api.github.com/repos/acme/api/issues/7',
    )

    const missing = vi.fn(async () => json({ message: 'Not Found' }, 404))
    expect(await createGithubSearchApi('t', missing).issue('acme/api#7')).toBeNull()

    const limited = vi.fn(async () => json({ message: 'API rate limit exceeded' }, 403))
    await expect(createGithubSearchApi('t', limited).issue('acme/api#7')).rejects.toEqual(
      new GithubApiError(403, 'API rate limit exceeded'),
    )
    expect(await createGithubSearchApi('t', ok).issue('no es ref')).toBeNull()
  })
})
