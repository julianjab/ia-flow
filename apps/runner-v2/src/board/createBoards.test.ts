import { describe, expect, it } from 'bun:test'
import type { GithubClient } from '@ia-flow/github-api'
import type { ProjectConfig } from '../config/RunnerConfig.js'
import { createBoards } from './createBoards.js'

const github = {} as GithubClient

describe('createBoards', () => {
  it('builds each project its own kind of board', () => {
    const projects = [
      {
        id: 'org',
        boardKind: 'projects-v2',
        board: { owner: 'la-haus', number: 119, ownerKind: 'orgs' },
        repos: [],
      },
      {
        id: 'repo',
        boardKind: 'issues',
        board: { owner: 'julianjab', number: 0 },
        issuesBoard: { statuses: ['Todo', 'Build'] },
        repos: [{ name: 'ia-flow', githubOwner: 'julianjab', githubRepo: 'ia-flow' }],
      },
    ] as unknown as ProjectConfig[]
    const boards = createBoards(projects, github)
    expect(boards.of('org').kind).toBe('projects-v2')
    expect(boards.of('repo').kind).toBe('issues')
    // Sólo el de issues trae su propio intake: el de un Project v2 es el default del intake.
    expect(boards.of('org').intake).toBeUndefined()
    expect(boards.of('repo').intake).toBeDefined()
  })
})
