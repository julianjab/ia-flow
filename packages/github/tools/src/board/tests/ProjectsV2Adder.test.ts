import type { GithubClient } from '@ia-flow/github-api'
import { describe, expect, it, vi } from 'vitest'
import { ProjectsV2Adder } from '../ProjectsV2Adder.js'

const board = { owner: 'julianjab', number: 2 }

function github(project: { id: string } | null) {
  const graphql = vi.fn(async (query: string, _vars?: unknown) =>
    query.includes('projectV2(number')
      ? { repositoryOwner: { projectV2: project } }
      : { addProjectV2ItemById: { item: { id: 'PVTI_new' } } },
  )
  return { client: { graphql } as unknown as GithubClient, graphql }
}

describe('ProjectsV2Adder', () => {
  it('finds the board of a personal account and adds the issue to it', async () => {
    const { client, graphql } = github({ id: 'PVT_board' })
    expect(await new ProjectsV2Adder(client, board).addIssue('I_1')).toEqual({ itemId: 'PVTI_new' })
    expect(graphql.mock.calls[0]?.[1]).toEqual({ owner: 'julianjab', number: 2 })
    expect(graphql.mock.calls.at(-1)?.[1]).toEqual({ projectId: 'PVT_board', contentId: 'I_1' })
  })

  it('resolves the board id once, however many issues it adds', async () => {
    const { client, graphql } = github({ id: 'PVT_board' })
    const adder = new ProjectsV2Adder(client, board)
    await adder.addIssue('I_1')
    await adder.addIssue('I_2')
    expect(graphql.mock.calls.filter(([q]) => q.includes('projectV2(number'))).toHaveLength(1)
  })

  it('fails when the board does not exist, and looks it up again next time', async () => {
    const { client, graphql } = github(null)
    const adder = new ProjectsV2Adder(client, board)
    await expect(adder.addIssue('I_1')).rejects.toThrow(/no se encontró el board julianjab#2/)
    await expect(adder.addIssue('I_1')).rejects.toThrow(/no se encontró el board/)
    expect(graphql.mock.calls.filter(([q]) => q.includes('projectV2(number'))).toHaveLength(2)
  })
})
