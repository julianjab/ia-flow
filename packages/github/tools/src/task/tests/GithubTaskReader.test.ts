import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GithubTaskReader } from '../GithubTaskReader.js'

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
