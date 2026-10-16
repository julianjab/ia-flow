import { describe, expect, it } from 'bun:test'
import type { GithubClient } from '@ia-flow/github-api'
import type { IssueRef } from '@ia-flow/github-tools'
import { BoardMoves, issueOf } from './BoardMoves.js'
import type { BoardCard } from './classify.js'

const todo: BoardCard = {
  ref: 'o/r#1',
  projectId: 'p',
  title: 'Por arrancar',
  url: 'https://github.com/o/r/issues/1',
  status: 'Todo',
  labels: [],
  updatedAt: '2026-10-16T10:00:00Z',
  blockedBy: [],
}

interface Issue {
  node_id: string
  html_url: string
  state: string
  pull_request?: unknown
}

/** GitHub de mentira: el permiso del repo y los issues que existen. */
function github(issues: Record<number, Issue>, push = true) {
  const calls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    calls.push(url.pathname)
    const issue = url.pathname.match(/\/issues\/(\d+)$/)
    if (issue) {
      const found = issues[Number(issue[1])]
      return found ? Response.json(found) : new Response('{}', { status: 404 })
    }
    return Response.json({ permissions: { push } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function setup(
  options: {
    cards?: BoardCard[]
    live?: 'running' | 'paused'
    issues?: Record<number, Issue>
    push?: boolean
    holds?: boolean
    projects?: string[]
    failColumn?: boolean
  } = {},
) {
  const cards = options.cards ?? [todo]
  const written: Array<{ issue: IssueRef; set: Record<string, string>; by: GithubClient }> = []
  const added: string[] = []
  const changed: string[] = []
  const gh = github(options.issues ?? {}, options.push ?? true)
  const moves = new BoardMoves({
    inbox: {
      card: async (ref) => cards.find((card) => card.ref === ref),
    },
    isLive: () => options.live !== undefined,
    board: () => ({
      describe: () => 'o#1',
      meta: async () => ({ url: '', boardUrl: '', statuses: ['Todo', 'Refine', 'Build'] }),
      holds: () => options.holds ?? true,
      writerFor: (by) => ({
        setFields: async (issue, set) => {
          if (options.failColumn) throw new Error('el item no está en el proyecto')
          written.push({ issue, set, by })
        },
      }),
      adderFor: () => ({
        addIssue: async (nodeId) => {
          added.push(nodeId)
          return { itemId: 'PVTI_1' }
        },
      }),
    }),
    projects: options.projects ?? ['p'],
    todo: 'Todo',
    changed: (ref) => changed.push(ref),
    fetchImpl: gh.fetchImpl,
  })
  return { moves, written, added, changed, calls: gh.calls }
}

const julian = { token: 'gho_x', login: 'julian' }

describe('issueOf', () => {
  it('takes a ref or the link of the issue', () => {
    expect(issueOf('o/r#3')).toEqual({ owner: 'o', repo: 'r', number: 3 })
    expect(issueOf(' https://github.com/o/r/issues/3#issuecomment-1 ')).toEqual({
      owner: 'o',
      repo: 'r',
      number: 3,
    })
    expect(() => issueOf('r#3')).toThrow('no es owner/repo#n')
  })
})

describe('moving a card', () => {
  it('writes the column with the token of whoever moves it and tells the inbox', async () => {
    const { moves, written, changed } = setup()
    const result = await moves.move('o/r#1', 'Refine', julian)
    expect(result).toEqual({ ok: true, message: 'movida de Todo a Refine', github_login: 'julian' })
    expect(written.map(({ issue, set }) => ({ issue, set }))).toEqual([
      { issue: { owner: 'o', repo: 'r', number: 1 }, set: { Status: 'Refine' } },
    ])
    expect(changed).toEqual(['o/r#1'])
  })

  it('refuses a column the board does not have, the one it is in, and a card off the board', async () => {
    const { moves, written } = setup()
    await expect(moves.move('o/r#1', 'Done', julian)).rejects.toMatchObject({ status: 400 })
    await expect(moves.move('o/r#1', 'Todo', julian)).rejects.toMatchObject({ status: 409 })
    await expect(moves.move('o/r#9', 'Refine', julian)).rejects.toMatchObject({ status: 404 })
    expect(written).toEqual([])
  })

  it('does not move a card an agent is working on', async () => {
    const { moves, written } = setup({ live: 'running' })
    await expect(moves.move('o/r#1', 'Build', julian)).rejects.toThrow('agente corriendo')
    expect(written).toEqual([])
  })

  it('refuses someone who cannot write to the repo', async () => {
    const { moves, written } = setup({ push: false })
    await expect(moves.move('o/r#1', 'Refine', julian)).rejects.toMatchObject({ status: 403 })
    expect(written).toEqual([])
  })
})

describe('adding an issue to the board', () => {
  const open: Issue = {
    node_id: 'I_2',
    html_url: 'https://github.com/O/R/issues/2',
    state: 'open',
  }

  it('adds it with the ref GitHub uses and puts it in Todo by default', async () => {
    const { moves, added, written, changed } = setup({ issues: { 2: open } })
    const result = await moves.add({ issue: 'o/r#2' }, julian)
    expect(result).toMatchObject({ ok: true, ref: 'O/R#2', status: 'Todo', github_login: 'julian' })
    expect(added).toEqual(['I_2'])
    expect(written.map(({ issue, set }) => ({ issue, set }))).toEqual([
      { issue: { owner: 'O', repo: 'R', number: 2 }, set: { Status: 'Todo' } },
    ])
    expect(changed).toEqual(['O/R#2'])
  })

  it('goes to the column it is asked for', async () => {
    const { moves, written } = setup({ issues: { 2: open } })
    await moves.add({ issue: 'https://github.com/o/r/issues/2', status: 'Refine' }, julian)
    expect(written[0]?.set).toEqual({ Status: 'Refine' })
  })

  it('refuses one already on the board, a PR, a closed issue and one GitHub does not find', async () => {
    const { moves, added } = setup({
      issues: {
        1: { node_id: 'I_1', html_url: 'https://github.com/o/r/issues/1', state: 'open' },
        3: { ...open, html_url: 'https://github.com/o/r/pull/3', pull_request: {} },
        4: { ...open, html_url: 'https://github.com/o/r/issues/4', state: 'closed' },
      },
    })
    await expect(moves.add({ issue: 'o/r#1' }, julian)).rejects.toThrow(
      'ya está en el board (Todo)',
    )
    await expect(moves.add({ issue: 'o/r#3' }, julian)).rejects.toThrow('es un PR')
    await expect(moves.add({ issue: 'o/r#4' }, julian)).rejects.toThrow('está cerrado')
    await expect(moves.add({ issue: 'o/r#5' }, julian)).rejects.toMatchObject({ status: 404 })
    expect(added).toEqual([])
  })

  it('refuses a repo the board cannot hold, before asking GitHub', async () => {
    const { moves, calls } = setup({ holds: false, issues: { 2: open } })
    await expect(moves.add({ issue: 'o/r#2' }, julian)).rejects.toThrow('no es parte de o#1')
    expect(calls).toEqual([])
  })

  it('asks for the project when the runner has more than one', async () => {
    const { moves } = setup({ projects: ['p', 'q'], issues: { 2: open } })
    await expect(moves.add({ issue: 'o/r#2' }, julian)).rejects.toThrow('¿a qué proyecto?')
    await expect(moves.add({ issue: 'o/r#2', project_id: 'z' }, julian)).rejects.toMatchObject({
      status: 404,
    })
    expect(await moves.add({ issue: 'o/r#2', project_id: 'q' }, julian)).toMatchObject({ ok: true })
  })

  it('never moves, while adding, a card an agent is working on', async () => {
    const { moves, added } = setup({ cards: [], live: 'running', issues: { 2: open } })
    await expect(moves.add({ issue: 'o/r#2' }, julian)).rejects.toThrow('agente corriendo')
    expect(added).toEqual([])
  })

  it('says what was left done when GitHub refuses the column', async () => {
    const { moves, added, changed } = setup({ failColumn: true, issues: { 2: open } })
    const error = moves.add({ issue: 'o/r#2' }, julian)
    await expect(error).rejects.toMatchObject({ status: 502 })
    await expect(error).rejects.toThrow(
      'O/R#2 quedó en el board, pero no pude ponerle la columna Todo',
    )
    expect(added).toEqual(['I_2'])
    expect(changed).toEqual(['O/R#2'])
  })
})
