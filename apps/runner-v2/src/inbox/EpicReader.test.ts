import { describe, expect, it } from 'bun:test'
import type { GithubClient } from '@ia-flow/github-api'
import type { BoardCard } from './classify.js'
import { EpicReader, toEpicDetail } from './EpicReader.js'

const sub = (number: number, state: 'OPEN' | 'CLOSED', repo = 'r') => ({
  number,
  title: `Hijo ${number}`,
  url: `https://github.com/o/${repo}/issues/${number}`,
  state,
  repository: { name: repo, owner: { login: 'o' } },
})

const page = {
  repository: {
    issue: {
      number: 10,
      title: 'Épica: embudo',
      url: 'https://github.com/o/r/issues/10',
      subIssuesSummary: { completed: 1, total: 3 },
      subIssues: { nodes: [sub(11, 'CLOSED'), sub(12, 'OPEN'), sub(13, 'OPEN', 'web')] },
    },
  },
}

const card: BoardCard = {
  ref: 'o/r#12',
  projectId: 'p',
  title: 'Hijo 12',
  url: 'https://github.com/o/r/issues/12',
  status: 'Build',
  labels: [],
  updatedAt: '2026-10-01T00:00:00Z',
  blockedBy: ['o/r#11'],
  pr: { number: 40, url: 'https://github.com/o/r/pull/40' },
}

describe('toEpicDetail', () => {
  it('lists every sub-issue, with the column, blockers and PR of the ones on a board', () => {
    const detail = toEpicDetail('o/r#10', page, (ref) => (ref === card.ref ? card : undefined))
    expect(detail?.epic).toEqual({
      ref: 'o/r#10',
      title: 'Épica: embudo',
      url: 'https://github.com/o/r/issues/10',
      done: 1,
      total: 3,
    })
    expect(detail?.children).toEqual([
      { ref: 'o/r#11', title: 'Hijo 11', url: sub(11, 'CLOSED').url, state: 'closed' },
      {
        ref: 'o/r#12',
        title: 'Hijo 12',
        url: card.url,
        state: 'open',
        status: 'Build',
        blocked_by: ['o/r#11'],
        pr: card.pr,
      },
      { ref: 'o/web#13', title: 'Hijo 13', url: sub(13, 'OPEN', 'web').url, state: 'open' },
    ])
  })

  it('counts the children when GitHub has no summary, and is undefined without the issue', () => {
    const bare = { repository: { issue: { ...page.repository.issue, subIssuesSummary: null } } }
    expect(toEpicDetail('o/r#10', bare, () => undefined)?.epic).toMatchObject({ done: 1, total: 3 })
    expect(toEpicDetail('o/r#10', { repository: { issue: null } }, () => undefined)).toBeUndefined()
  })
})

describe('EpicReader', () => {
  const client = (graphql: () => Promise<unknown>) => ({ graphql }) as unknown as GithubClient

  it('reads the epic and crosses it with the board cards', async () => {
    const reader = new EpicReader(
      client(async () => page),
      async () => [card],
    )
    const detail = await reader.detail('o/r#10')
    expect(detail?.children.map((c) => c.status)).toEqual([undefined, 'Build', undefined])
  })

  it('an issue GitHub cannot resolve is undefined; any other failure is thrown', async () => {
    const missing = new EpicReader(
      client(async () => {
        throw new Error(
          'GithubClient: GraphQL → Could not resolve to an Issue with the number of 99.',
        )
      }),
      async () => [],
    )
    expect(await missing.detail('o/r#99')).toBeUndefined()
    expect(await missing.detail('no-es-una-ref')).toBeUndefined()
    const down = new EpicReader(
      client(async () => {
        throw new Error('GithubClient: 502')
      }),
      async () => [],
    )
    await expect(down.detail('o/r#10')).rejects.toThrow('502')
  })
})
