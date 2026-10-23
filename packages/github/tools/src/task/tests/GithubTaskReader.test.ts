import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GithubTaskReader } from '../GithubTaskReader.js'
import { stackBlockers } from '../stack.js'

/** El repo de la task, como lo devuelve GitHub (mayúsculas incluidas). */
const REPO = { nameWithOwner: 'O/R' }

/** Un GitHub que responde a cualquier GraphQL con `issue`. */
function readerWith(issue: Record<string, unknown>) {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify({ data: { repository: { issue } } }), { status: 200 }),
  )
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return new GithubTaskReader(client)
}

describe('GithubTaskReader.linkedBranches', () => {
  it('the heads of the open PRs that close the issue first, oldest first, then the linked branches', async () => {
    const reader = readerWith({
      linkedBranches: { nodes: [{ ref: { name: 'feat/linked' } }, { ref: null }] },
      closedByPullRequestsReferences: {
        nodes: [
          {
            number: 3534,
            headRefName: 'feat/crm-fields-in-profiling-prompt',
            createdAt: '2026-10-19T15:56:00Z',
            repository: REPO,
          },
          {
            number: 3522,
            headRefName: 'feat/add-crm-fields-to-profiling-prompt',
            createdAt: '2026-10-16T19:06:00Z',
            repository: REPO,
          },
        ],
      },
    })

    expect(await reader.linkedBranches('o', 'r', 1)).toEqual([
      'feat/add-crm-fields-to-profiling-prompt',
      'feat/crm-fields-in-profiling-prompt',
      'feat/linked',
    ])
  })

  it('an open PR beats the empty branches link_branch linked on earlier re-entries (subscriptions#1775)', async () => {
    const reader = readerWith({
      linkedBranches: {
        nodes: [
          { ref: { name: 'feat/resolve-assignable-stages-weights-pipeline' } },
          { ref: { name: 'feat/resolve-assignable-stages-against-pipeline' } },
        ],
      },
      closedByPullRequestsReferences: {
        nodes: [
          {
            number: 1778,
            state: 'OPEN',
            headRefName: 'feat/core-assignment-motor-resolve-assignable-stages',
            createdAt: '2026-10-06T22:00:00Z',
            repository: REPO,
          },
        ],
      },
    })

    const [branch] = await reader.linkedBranches('o', 'r', 1)
    expect(branch).toBe('feat/core-assignment-motor-resolve-assignable-stages')
  })

  it('a merged PR does not give the task its branch', async () => {
    const reader = readerWith({
      linkedBranches: { nodes: [{ ref: { name: 'feat/linked' } }] },
      closedByPullRequestsReferences: {
        nodes: [{ number: 5, state: 'MERGED', headRefName: 'feat/old', repository: REPO }],
      },
    })

    expect(await reader.linkedBranches('o', 'r', 1)).toEqual(['feat/linked'])
  })

  it('a branch the agent pushed without linking is found through its PR, never from another repo or a fork', async () => {
    const reader = readerWith({
      linkedBranches: { nodes: [] },
      closedByPullRequestsReferences: {
        nodes: [
          { number: 9, headRefName: 'feat/from-a-fork', isCrossRepository: true, repository: REPO },
          { number: 8, headRefName: 'feat/other-repo', repository: { nameWithOwner: 'o/other' } },
          {
            number: 3522,
            headRefName: 'feat/add-crm-fields-to-profiling-prompt',
            repository: REPO,
          },
        ],
      },
    })

    expect(await reader.linkedBranches('o', 'r', 1)).toEqual([
      'feat/add-crm-fields-to-profiling-prompt',
    ])
  })

  it('does not repeat a branch that is linked and also has the PR', async () => {
    const reader = readerWith({
      linkedBranches: { nodes: [{ ref: { name: 'feat/x' } }] },
      closedByPullRequestsReferences: {
        nodes: [{ number: 1, headRefName: 'feat/x', repository: REPO }],
      },
    })

    expect(await reader.linkedBranches('o', 'r', 1)).toEqual(['feat/x'])
  })
})

/** Un GitHub que contesta por ruta: GraphQL con el `repository.issue` de cada número, REST por URL. */
function routedReader(
  closingPr: Record<number, number | undefined>,
  rest: Record<string, unknown>,
) {
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path === '/graphql') {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { number: number } }
      const pr = closingPr[variables.number]
      const nodes = pr === undefined ? [] : [{ number: pr, state: 'OPEN' }]
      return new Response(
        JSON.stringify({
          data: { repository: { issue: { closedByPullRequestsReferences: { nodes } } } },
        }),
      )
    }
    const body = rest[path]
    return body === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200 })
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return new GithubTaskReader(client)
}

describe('stackBlockers (con GithubTaskReader)', () => {
  it('los blockers abiertos con su PR abierto; los cerrados no cuentan', async () => {
    const reader = routedReader(
      { 1: 10, 2: undefined },
      {
        '/repos/la-haus/api/pulls/10': {
          number: 10,
          state: 'open',
          html_url: 'https://github.com/la-haus/api/pull/10',
          head: { ref: 'feat/a', sha: 'abc' },
          base: { ref: 'main' },
        },
      },
    )

    expect(
      await stackBlockers(reader, [
        { state: 'open', html_url: 'https://github.com/la-haus/api/issues/1' },
        { state: 'open', html_url: 'https://github.com/la-haus/web/issues/2' },
        { state: 'closed', html_url: 'https://github.com/la-haus/api/issues/3' },
      ]),
    ).toEqual([
      {
        owner: 'la-haus',
        repo: 'api',
        number: 1,
        pr: { number: 10, headRef: 'feat/a', baseRef: 'main' },
      },
      { owner: 'la-haus', repo: 'web', number: 2 },
    ])
  })
})

describe('GithubTaskReader.contains', () => {
  it('ahead o identical: la rama ya trae el commit', async () => {
    const reader = routedReader(
      {},
      {
        '/repos/o/r/compare/abc...feat%2Fb': { status: 'ahead' },
        '/repos/o/r/compare/abc...feat%2Fc': { status: 'diverged' },
      },
    )

    expect(await reader.contains('o', 'r', 'abc', 'feat/b')).toBe(true)
    expect(await reader.contains('o', 'r', 'abc', 'feat/c')).toBe(false)
  })
})

/** Un GitHub cuyo GraphQL contesta `data` y cuyo REST contesta por ruta. */
function graphqlReader(data: Record<string, unknown>, rest: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname
    if (path === '/graphql') return new Response(JSON.stringify({ data }))
    return new Response(JSON.stringify(rest[path] ?? {}))
  })
  const client = new GithubClient({
    auth: new GithubTokenAuth('t'),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  })
  return new GithubTaskReader(client)
}

describe('GithubTaskReader.closingIssues — PR apilado', () => {
  const pr = (baseRefName: string, merged = false) => ({
    repository: {
      defaultBranchRef: { name: 'main' },
      pullRequest: {
        body: 'Closes #5',
        baseRefName,
        merged,
        closingIssuesReferences: { nodes: [] },
      },
    },
  })

  it('un PR que no apunta a la default: sus issues salen del Closes del body', async () => {
    expect(await graphqlReader(pr('feat/a')).closingIssues('o', 'r', 20)).toEqual([
      { owner: 'o', repo: 'r', number: 5 },
    ])
  })

  it('un PR apilado ya mergeado en la rama de su base no cerró nada', async () => {
    expect(await graphqlReader(pr('feat/a', true)).closingIssues('o', 'r', 20)).toEqual([])
  })

  it('un PR contra la default sin vínculo no se inventa uno', async () => {
    expect(await graphqlReader(pr('main')).closingIssues('o', 'r', 20)).toEqual([])
  })
})

describe('GithubTaskReader.openPullRequest — PR apilado', () => {
  it('sin PR que cierre el issue, el abierto desde una rama vinculada', async () => {
    const reader = graphqlReader(
      {
        repository: {
          issue: {
            closedByPullRequestsReferences: { nodes: [] },
            linkedBranches: {
              nodes: [
                { ref: { associatedPullRequests: { nodes: [] } } },
                { ref: { associatedPullRequests: { nodes: [{ number: 20 }] } } },
              ],
            },
          },
        },
      },
      {
        '/repos/o/r/pulls/20': {
          number: 20,
          state: 'open',
          html_url: 'https://github.com/o/r/pull/20',
          head: { ref: 'feat/b', sha: 'def' },
          base: { ref: 'feat/a' },
        },
      },
    )

    expect(await reader.openPullRequest({ owner: 'o', repo: 'r', number: 5 })).toMatchObject({
      number: 20,
      headRef: 'feat/b',
      baseRef: 'feat/a',
    })
  })
})
