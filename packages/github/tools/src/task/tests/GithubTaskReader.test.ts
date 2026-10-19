import { GithubClient } from '@ia-flow/github-api'
import { GithubTokenAuth } from '@ia-flow/github-auth'
import { describe, expect, it, vi } from 'vitest'
import { GithubTaskReader } from '../GithubTaskReader.js'

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
  it('the linked branches first, then the heads of the open PRs that close the issue, oldest first', async () => {
    const reader = readerWith({
      linkedBranches: { nodes: [{ ref: { name: 'feat/linked' } }, { ref: null }] },
      closedByPullRequestsReferences: {
        nodes: [
          {
            number: 3534,
            headRefName: 'feat/crm-fields-in-profiling-prompt',
            createdAt: '2026-10-19T15:56:00Z',
          },
          {
            number: 3522,
            headRefName: 'feat/add-crm-fields-to-profiling-prompt',
            createdAt: '2026-10-16T19:06:00Z',
          },
        ],
      },
    })

    expect(await reader.linkedBranches('o', 'r', 1)).toEqual([
      'feat/linked',
      'feat/add-crm-fields-to-profiling-prompt',
      'feat/crm-fields-in-profiling-prompt',
    ])
  })

  it('a branch the agent pushed without linking is found through its PR', async () => {
    const reader = readerWith({
      linkedBranches: { nodes: [] },
      closedByPullRequestsReferences: {
        nodes: [
          { number: 9, headRefName: 'feat/from-a-fork', isCrossRepository: true },
          { number: 3522, headRefName: 'feat/add-crm-fields-to-profiling-prompt' },
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
      closedByPullRequestsReferences: { nodes: [{ number: 1, headRefName: 'feat/x' }] },
    })

    expect(await reader.linkedBranches('o', 'r', 1)).toEqual(['feat/x'])
  })
})
