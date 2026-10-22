import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GithubTaskReader } from '../GithubTaskReader.js'

/** Un GitHub REST que contesta `body` y anota qué URL se le pidió. */
function readerAnswering(body: unknown) {
  const urls: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify(body), { status: 200 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return { reader: new GithubTaskReader(client), urls }
}

describe('GithubTaskReader.subIssues', () => {
  it('lee los sub-issues del padre, hasta 100', async () => {
    const children = [
      { number: 2, state: 'open', repository_url: 'https://api.github.com/repos/o/r' },
    ]
    const { reader, urls } = readerAnswering(children)

    expect(await reader.subIssues('o', 'r', 1)).toEqual(children)
    expect(urls[0]).toBe('https://api.github.com/repos/o/r/issues/1/sub_issues?per_page=100')
  })
})

describe('GithubTaskReader.mergeability', () => {
  it('lee mergeable, su estado y la base del PR', async () => {
    const { reader, urls } = readerAnswering({
      number: 9,
      mergeable: false,
      mergeable_state: 'dirty',
      base: { ref: 'main' },
    })

    expect(await reader.mergeability('o', 'r', 9)).toEqual({
      mergeable: false,
      state: 'dirty',
      base: 'main',
    })
    expect(urls[0]).toBe('https://api.github.com/repos/o/r/pulls/9')
  })

  it('sin calcular todavía (null o ausente) es null', async () => {
    expect(await readerAnswering({ mergeable: null }).reader.mergeability('o', 'r', 9)).toEqual({
      mergeable: null,
    })
    expect(await readerAnswering({ number: 9 }).reader.mergeability('o', 'r', 9)).toEqual({
      mergeable: null,
    })
  })
})
