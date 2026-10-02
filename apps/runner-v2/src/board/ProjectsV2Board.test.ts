import { describe, expect, it } from 'bun:test'
import type { GithubClient } from '@ia-flow/github-api'
import type { BoardCard } from '@ia-flow/github-tools'
import type { BoardReader } from '../inbox/BoardReader.js'
import { Boards } from './Boards.js'
import { ProjectsV2Board } from './ProjectsV2Board.js'

const ref = { owner: 'la-haus', number: 119, ownerKind: 'orgs' as const }

const card = (extra: Partial<BoardCard> = {}): BoardCard => ({
  ref: 'la-haus/subscriptions#7',
  itemId: 'PVTI_7',
  projectId: 'p',
  title: 't',
  url: 'u',
  labels: [],
  updatedAt: '2026-01-01T00:00:00Z',
  blockedBy: [],
  ...extra,
})

/** El lector de la bandeja de mentira: guarda con qué spec lo llamaron. */
function reader() {
  const calls: string[] = []
  const fake = {
    cards: async (spec: { projectId: string }) => {
      calls.push(`cards ${spec.projectId}`)
      return [card()]
    },
    meta: async (spec: { projectId: string }) => {
      calls.push(`meta ${spec.projectId}`)
      return { url: 'u', boardUrl: 'b', statuses: ['Build'] }
    },
    invalidate: () => {
      calls.push('invalidate')
    },
  }
  return { fake: fake as unknown as BoardReader, calls }
}

describe('ProjectsV2Board', () => {
  it('reads the inbox through the shared reader, with its own project id and board', async () => {
    const { fake, calls } = reader()
    const board = new ProjectsV2Board('p', ref, {} as GithubClient, fake)
    expect(await board.cards()).toHaveLength(1)
    expect((await board.meta()).statuses).toEqual(['Build'])
    board.invalidate()
    expect(calls).toEqual(['cards p', 'meta p', 'invalidate'])
  })

  it('translates a Status move of a card into issue.status_changed', () => {
    const board = new ProjectsV2Board('p', ref, {} as GithubClient, reader().fake)
    const location = board.locate('projects_v2_item', {
      action: 'edited',
      projects_v2_item: { node_id: 'PVTI_7', content_type: 'Issue' },
      changes: {
        field_value: { field_name: 'Status', field_type: 'single_select', to: { name: 'Review' } },
      },
      sender: { login: 'julian' },
    })
    expect(location).toMatchObject({
      item: 'PVTI_7',
      emit: 'issue.status_changed',
      status: 'Review',
    })
  })

  it('builds the delivery that simulates "the card arrived at a status"', () => {
    const board = new ProjectsV2Board('p', ref, {} as GithubClient, reader().fake)
    const delivery = board.statusChange(card(), 'Review', 'julian')
    expect(delivery.event).toBe('projects_v2_item')
    // Y el mismo `locate` lo lee como el cambio de columna que es.
    expect(board.locate(delivery.event, delivery.payload)).toMatchObject({
      item: 'PVTI_7',
      emit: 'issue.status_changed',
      status: 'Review',
    })
  })

  it('cannot simulate a move for a card with no item id', () => {
    const board = new ProjectsV2Board('p', ref, {} as GithubClient, reader().fake)
    expect(() => board.statusChange(card({ itemId: undefined }), 'Review', 'julian')).toThrow(
      /no está en el board/,
    )
  })

  it('writes with the client it is given (a person, not the runner)', async () => {
    const runner = {
      graphql: async () => ({ repository: { issue: null } }),
    } as unknown as GithubClient
    const used: string[] = []
    const person = {
      graphql: async () => {
        used.push('person')
        return { repository: { issue: null } }
      },
    } as unknown as GithubClient
    const board = new ProjectsV2Board('p', ref, runner, reader().fake)
    // El issue no está en el board: tira, pero sólo después de preguntarle a GitHub con ESE cliente.
    await expect(
      board.writerFor(person).setFields(
        { owner: 'la-haus', repo: 'subscriptions', number: 7 },
        {
          Status: 'Build',
        },
      ),
    ).rejects.toThrow(/no está en el proyecto la-haus#119/)
    expect(used).toEqual(['person'])
  })
})

describe('Boards', () => {
  const boardOf = (projectId: string, calls: string[]) =>
    new ProjectsV2Board(
      projectId,
      ref,
      {} as GithubClient,
      {
        cards: async () => [card({ projectId })],
        meta: async () => ({ url: projectId, boardUrl: projectId, statuses: [] }),
        invalidate: () => {
          calls.push(`invalidate ${projectId}`)
        },
      } as unknown as BoardReader,
    )

  it('gives each project its own board and fails clearly for one it does not have', async () => {
    const boards = new Boards([boardOf('a', []), boardOf('b', [])])
    expect((await boards.cards({ projectId: 'a' }))[0]?.projectId).toBe('a')
    expect((await boards.meta({ projectId: 'b' })).url).toBe('b')
    expect(() => boards.of('nope')).toThrow(/no tiene board/)
    expect(boards.writerFor('nope', {} as GithubClient)).toBeUndefined()
  })

  it('invalidates the cards of every board', () => {
    const calls: string[] = []
    new Boards([boardOf('a', calls), boardOf('b', calls)]).invalidate()
    expect(calls).toEqual(['invalidate a', 'invalidate b'])
  })
})
