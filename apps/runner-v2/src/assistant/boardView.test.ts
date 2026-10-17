import { describe, expect, it } from 'bun:test'
import type { BoardRest, BoardRestItem, Inbox, InboxItem } from '@ia-flow/shared'
import { boardView } from './boardView.js'

const COLUMNS = ['Todo', 'Refine', 'Build', 'Review', 'Done']

function item(ref: string, status: string | undefined, extra: Partial<InboxItem> = {}): InboxItem {
  return {
    ref,
    project_id: 'p',
    title: `t ${ref}`,
    url: 'u',
    group: 'need',
    kind: 'merge',
    ...(status ? { status } : {}),
    labels: [],
    why: 'x',
    since: '2026-10-01T00:00:00Z',
    actions: [],
    ...extra,
  }
}

function card(ref: string, updated_at: string): BoardRestItem {
  return { ref, project_id: 'p', title: `t ${ref}`, url: 'u', labels: [], updated_at }
}

/** Sin columnas (`[]`): el `meta` del board falló y el proyecto no las trae. */
function inboxOf(items: InboxItem[], statuses: string[] = COLUMNS): Inbox {
  return {
    generated_at: '2026-10-01T00:00:00Z',
    projects: [
      { id: 'p', board: { owner: 'o', number: 1 }, ...(statuses.length ? { statuses } : {}) },
    ],
    items,
  }
}

const rest: BoardRest = {
  columns: [
    {
      status: 'Todo',
      items: [card('o/r#2', '2026-10-03T00:00:00Z'), card('o/r#3', '2026-10-02T00:00:00Z')],
    },
    { status: 'Review', items: [card('o/r#4', '2026-10-01T00:00:00Z')] },
  ],
}

describe('boardView', () => {
  it('the columns of the board, in its order, with their open cards — the empty ones too', () => {
    const view = boardView(inboxOf([item('o/r#1', 'Review')]), rest)
    expect(view.columns).toEqual([
      { status: 'Todo', count: 2 },
      { status: 'Refine', count: 0 },
      { status: 'Build', count: 0 },
      { status: 'Review', count: 2 },
      { status: 'Done', count: 0 },
    ])
  })

  it('a column the board does not declare (or no status) goes at the end', () => {
    const extra: BoardRest = {
      columns: [
        ...rest.columns,
        { status: 'Sin status', items: [card('o/r#5', '2026-10-01T00:00:00Z')] },
      ],
    }
    const view = boardView(inboxOf([item('o/r#1', 'Archivo')]), extra)
    expect(view.columns.map((column) => column.status)).toEqual([
      ...COLUMNS,
      'Archivo',
      'Sin status',
    ])
    expect(view.columns.at(-1)).toEqual({ status: 'Sin status', count: 1 })
  })

  it('merges the inbox and the rest: in_inbox says which the inbox shows', () => {
    const view = boardView(
      inboxOf([item('o/r#1', 'Review', { pr: { number: 9, url: 'p' }, blocked_by: ['o/r#7'] })]),
      rest,
    )
    expect(view.cards.map((c) => c.ref)).toEqual(['o/r#2', 'o/r#3', 'o/r#1', 'o/r#4'])
    expect(view.cards.find((c) => c.ref === 'o/r#1')).toEqual({
      ref: 'o/r#1',
      project: 'p',
      title: 't o/r#1',
      status: 'Review',
      labels: [],
      in_inbox: true,
      group: 'need',
      kind: 'merge',
      pr: 9,
      blocked_by: ['o/r#7'],
    })
    expect(view.cards.find((c) => c.ref === 'o/r#2')).toEqual({
      ref: 'o/r#2',
      project: 'p',
      title: 't o/r#2',
      status: 'Todo',
      labels: [],
      in_inbox: false,
      updated_at: '2026-10-03T00:00:00Z',
    })
    expect(view.note).toContain('in_inbox: false')
  })

  it('filters by a column of the board; an empty one says so with its count', () => {
    const todo = boardView(inboxOf([]), rest, { status: 'Todo' })
    expect(todo.cards.map((c) => c.ref)).toEqual(['o/r#2', 'o/r#3'])
    expect(todo.total).toBe(2)

    const build = boardView(inboxOf([]), rest, { status: 'Build' })
    expect(build.cards).toEqual([])
    expect(build.total).toBe(0)
    expect(build.columns.find((c) => c.status === 'Build')).toEqual({ status: 'Build', count: 0 })
  })

  it('a column the board does not have is an error that lists the valid ones', () => {
    expect(() => boardView(inboxOf([]), rest, { status: 'Backlog' })).toThrow(
      '"Backlog" no es una columna del board: Todo, Refine, Build, Review, Done',
    )
  })

  it('pages with total and next_offset, only while there are more', () => {
    const first = boardView(inboxOf([item('o/r#1', 'Review')]), rest, { limit: 3 })
    expect(first.total).toBe(4)
    expect(first.cards.map((c) => c.ref)).toEqual(['o/r#2', 'o/r#3', 'o/r#1'])
    expect(first.next_offset).toBe(3)

    const last = boardView(inboxOf([item('o/r#1', 'Review')]), rest, { offset: 3, limit: 3 })
    expect(last.cards.map((c) => c.ref)).toEqual(['o/r#4'])
    expect(last.next_offset).toBeUndefined()
  })

  it('without declared columns (the meta failed), the columns come from the cards and any status is accepted', () => {
    const view = boardView(inboxOf([], []), rest, { status: 'Backlog' })
    expect(view.columns).toEqual([
      { status: 'Review', count: 1 },
      { status: 'Todo', count: 2 },
    ])
    expect(view.cards).toEqual([])
    expect(view.note).toContain('No se pudieron leer las columnas')
  })

  it('in a runner with several projects, the columns are the union, without repeating', () => {
    const inbox: Inbox = {
      ...inboxOf([]),
      projects: [
        { id: 'a', board: { owner: 'o', number: 1 }, statuses: ['Todo', 'Build'] },
        { id: 'b', board: { owner: 'o', number: 2 }, statuses: ['Todo', 'QA'] },
      ],
    }
    expect(boardView(inbox, { columns: [] }).columns.map((c) => c.status)).toEqual([
      'Todo',
      'Build',
      'QA',
    ])
  })
})
