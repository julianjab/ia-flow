import { describe, expect, it } from 'bun:test'
import type { GithubClient } from '@ia-flow/github-api'
import { IssuesBoard, type RawIssueCard, toIssueCard } from './IssuesBoard.js'

const repo = { owner: 'julianjab', repo: 'ia-flow' }
const scheme = { prefix: 'status:', statuses: ['Todo', 'Refine', 'Build', 'Tests', 'Done'] }

const raw = (extra: Partial<RawIssueCard> = {}): RawIssueCard => ({
  number: 255,
  title: 'Bandeja',
  url: 'https://github.com/julianjab/ia-flow/issues/255',
  updatedAt: '2026-10-01T00:00:00Z',
  labels: { nodes: [{ name: 'bug' }, { name: 'status:build' }, { name: 'task-type:functional' }] },
  ...extra,
})

describe('toIssueCard', () => {
  it('reads status and type from the labels, and identifies the card by its ref', () => {
    expect(toIssueCard(raw(), repo, 'p', scheme)).toEqual({
      ref: 'julianjab/ia-flow#255',
      itemId: 'julianjab/ia-flow#255',
      projectId: 'p',
      title: 'Bandeja',
      url: 'https://github.com/julianjab/ia-flow/issues/255',
      status: 'Build',
      taskType: 'functional',
      labels: ['bug', 'status:build', 'task-type:functional'],
      updatedAt: '2026-10-01T00:00:00Z',
      blockedBy: [],
    })
  })

  it('keeps the open blockers and the open PR that closes it', () => {
    const ref = (n: number, state: string) => ({
      number: n,
      state,
      url: `https://github.com/julianjab/ia-flow/pull/${n}`,
      repository: { name: 'ia-flow', owner: { login: 'julianjab' } },
    })
    const card = toIssueCard(
      raw({
        blockedBy: { nodes: [ref(1, 'OPEN'), ref(2, 'CLOSED')] },
        closedByPullRequestsReferences: { nodes: [ref(9, 'CLOSED'), ref(10, 'OPEN')] },
      }),
      repo,
      'p',
      scheme,
    )
    expect(card.blockedBy).toEqual(['julianjab/ia-flow#1'])
    expect(card.pr).toEqual({ number: 10, url: 'https://github.com/julianjab/ia-flow/pull/10' })
  })

  it('a card with no status label has no status', () => {
    const card = toIssueCard(raw({ labels: { nodes: [{ name: 'bug' }] } }), repo, 'p', scheme)
    expect(card.status).toBeUndefined()
    expect(card.taskType).toBeUndefined()
  })
})

/** GitHub de mentira: sirve las páginas de issues y anota las consultas. */
function github(pages: RawIssueCard[][], issueLabels: string[] = []) {
  const queries: string[] = []
  let page = 0
  const client = {
    graphql: async (query: string) => {
      queries.push(query.includes('blockedBy') ? 'with-blockers' : 'no-blockers')
      const nodes = pages[page] ?? []
      page += 1
      return {
        repository: {
          issues: { pageInfo: { hasNextPage: page < pages.length, endCursor: `c${page}` }, nodes },
        },
      }
    },
    requestJson: async () => ({ labels: issueLabels.map((name) => ({ name })) }),
    request: async () => ({ ok: true, status: 204 }),
  } as unknown as GithubClient
  return { client, queries }
}

const boardWith = (client: GithubClient, statuses = scheme.statuses) =>
  new IssuesBoard('p', client, { repos: [repo], statuses })

describe('IssuesBoard cards', () => {
  it('lists the open issues of every repo, across pages', async () => {
    const { client } = github([[raw({ number: 1 })], [raw({ number: 2 })]])
    const cards = await boardWith(client).cards()
    expect(cards.map((card) => card.ref)).toEqual(['julianjab/ia-flow#1', 'julianjab/ia-flow#2'])
  })

  it('retries without blockers when GitHub rejects the field, and remembers it', async () => {
    let calls = 0
    const client = {
      graphql: async (query: string) => {
        calls += 1
        if (query.includes('blockedBy')) throw new Error('GraphQL → Field blockedBy not found')
        return {
          repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
        }
      },
    } as unknown as GithubClient
    const board = boardWith(client)
    await board.cards()
    board.invalidate()
    await board.cards()
    expect(calls).toBe(3) // 1ª: con (falla) + sin; 2ª: ya directo sin
  })

  it('fails clearly when the repo does not exist or cannot be read', async () => {
    const client = { graphql: async () => ({ repository: null }) } as unknown as GithubClient
    await expect(boardWith(client).cards()).rejects.toThrow(
      /repo julianjab\/ia-flow: no existe o no hay acceso/,
    )
  })

  it('caches for a minute and rereads after invalidate()', async () => {
    const { client, queries } = github([[raw()]])
    const board = boardWith(client)
    await board.cards()
    await board.cards()
    expect(queries).toHaveLength(1)
    board.invalidate()
    await board.cards()
    expect(queries).toHaveLength(2)
  })

  it('its meta points at the issues page and lists the declared columns', async () => {
    const meta = await boardWith(github([]).client).meta()
    expect(meta).toEqual({
      url: 'https://github.com/julianjab/ia-flow/issues',
      boardUrl: 'https://github.com/julianjab/ia-flow/issues',
      statuses: scheme.statuses,
    })
  })
})

describe('IssuesBoard intake', () => {
  it('the card of an issue of the catalog: its status and type from the labels', async () => {
    const { client } = github([], ['status:tests', 'task-type:technical'])
    expect(await boardWith(client).intake?.cardOf({ ...repo, number: 7 })).toEqual({
      itemId: 'julianjab/ia-flow#7',
      status: 'Tests',
      type: 'technical',
    })
  })

  it('no card for an issue of another repo, or for a pull request', async () => {
    const { client } = github([], ['status:build'])
    const board = boardWith(client)
    expect(await board.intake?.cardOf({ owner: 'otro', repo: 'x', number: 1 })).toBeUndefined()
    const pr = {
      requestJson: async () => ({ labels: [], pull_request: {} }),
    } as unknown as GithubClient
    expect(await boardWith(pr).intake?.cardOf({ ...repo, number: 1 })).toBeUndefined()
  })

  it('the issue behind an item id is the ref itself, when it is of the catalog', async () => {
    const board = boardWith(github([]).client)
    expect(await board.intake?.issueOfItem('julianjab/ia-flow#9')).toEqual({
      issue: { ...repo, number: 9 },
    })
    expect(await board.intake?.issueOfItem('otro/x#1')).toEqual({
      skipped: 'otro/x#1 no es de los repos de p',
    })
    expect(await board.intake?.issueOfItem('PVTI_x')).toEqual({
      skipped: '"PVTI_x" no es un issue de este board',
    })
  })

  it('adding an issue to the board is a no-op: it already is', async () => {
    expect(await boardWith(github([]).client).addIssue()).toEqual({})
  })
})

const issuesEvent = (action: string, label: string) => ({
  action,
  label: { name: label },
  issue: { number: 255, title: 't', body: '', labels: [{ name: label }] },
  repository: { name: 'ia-flow', owner: { login: 'julianjab' } },
  sender: { login: 'julian' },
})

describe('IssuesBoard events', () => {
  const board = boardWith(github([]).client)

  it('a Status label put on an issue is a column change, with the column in `to`', () => {
    expect(board.locate('issues', issuesEvent('labeled', 'status:build'))).toMatchObject({
      owner: 'julianjab',
      repo: 'ia-flow',
      number: 255,
      emit: 'issue.status_changed',
      status: 'Build',
      extra: { label: 'status:build', to: 'Build', sender: 'julian' },
    })
  })

  it('taking a Status label off is nothing: the new one arrives on its own', () => {
    expect(board.locate('issues', issuesEvent('unlabeled', 'status:refine'))).toEqual({
      skip: 'Status sin cambio (se sacó status:refine)',
    })
  })

  it('any other label stays an issue.labeled', () => {
    expect(board.locate('issues', issuesEvent('labeled', 'bug'))).toMatchObject({
      emit: 'issue.labeled',
      extra: { label: 'bug' },
    })
    expect(board.locate('issues', issuesEvent('unlabeled', 'working:yes'))).toMatchObject({
      emit: 'issue.unlabeled',
    })
  })

  it('a label that is not a declared column is not a Status', () => {
    expect(board.locate('issues', issuesEvent('labeled', 'status:archived'))).toMatchObject({
      emit: 'issue.labeled',
    })
  })

  it('comments, PRs and CI are read like for any board', () => {
    expect(
      board.locate('issue_comment', {
        action: 'created',
        issue: { number: 7, title: 't', labels: [] },
        repository: { name: 'ia-flow', owner: { login: 'julianjab' } },
        sender: { login: 'julian' },
        comment: { id: 1, body: 'hola' },
      }),
    ).toMatchObject({ emit: 'issue_comment', number: 7 })
  })

  it('the synthetic "card arrived at X" is read back as that column change', () => {
    const card = toIssueCard(raw(), repo, 'p', scheme)
    const delivery = board.statusChange(card, 'Tests', 'julian')
    expect(delivery.event).toBe('issues')
    expect(board.locate(delivery.event, delivery.payload)).toMatchObject({
      owner: 'julianjab',
      repo: 'ia-flow',
      number: 255,
      emit: 'issue.status_changed',
      status: 'Tests',
    })
  })
})

describe('IssuesBoard writes', () => {
  it('a move writes the label with the client it is given (the person, not the runner)', async () => {
    const calls: string[] = []
    const person = {
      requestJson: async (path: string, init: RequestInit = {}) => {
        calls.push(`${init.method ?? 'GET'} ${path}`)
        return { labels: [] }
      },
      request: async () => ({ ok: true, status: 204 }),
    } as unknown as GithubClient
    const board = boardWith(github([]).client)
    await board.writerFor(person).setFields({ ...repo, number: 5 }, { Status: 'Done' })
    expect(calls).toEqual([
      'GET /repos/julianjab/ia-flow/issues/5',
      'POST /repos/julianjab/ia-flow/issues/5/labels',
    ])
  })

  it('needs at least one repo', () => {
    expect(() => new IssuesBoard('p', {} as GithubClient, { repos: [] })).toThrow(/algún repo/)
  })
})
