import { describe, expect, it } from 'bun:test'
import type { BoardSpec } from './BoardReader.js'
import { CLOSED_MAX, ClosedCardsReader, newestClosed, toClosedCard } from './ClosedCards.js'

const spec: BoardSpec = { projectId: 'core', board: { owner: 'acme', number: 7 } }

const item = (n: number, closedAt: string, over: Record<string, unknown> = {}) => ({
  isArchived: false,
  fieldValues: { nodes: [{ name: 'Done', field: { name: 'Status' } }] },
  content: {
    number: n,
    title: `Tarea ${n}`,
    url: `https://github.com/acme/api/issues/${n}`,
    state: 'CLOSED',
    closedAt,
    repository: { name: 'api', owner: { login: 'acme' } },
    labels: { nodes: [{ name: 'bug' }] },
    ...over,
  },
})

describe('toClosedCard', () => {
  it('una card cerrada con su columna, labels y cuándo se cerró', () => {
    expect(toClosedCard(item(3, '2026-01-02T10:00:00Z'), spec)).toEqual({
      ref: 'acme/api#3',
      projectId: 'core',
      title: 'Tarea 3',
      url: 'https://github.com/acme/api/issues/3',
      status: 'Done',
      labels: ['bug'],
      closedAt: '2026-01-02T10:00:00Z',
    })
  })

  it('una abierta, archivada o que no es issue no cuenta', () => {
    expect(toClosedCard(item(3, '', { state: 'OPEN' }), spec)).toBeUndefined()
    expect(toClosedCard({ ...item(3, ''), isArchived: true }, spec)).toBeUndefined()
    expect(toClosedCard({ isArchived: false, content: {} }, spec)).toBeUndefined()
  })
})

describe('newestClosed', () => {
  it('las cerradas más recientes primero, hasta el tope', () => {
    const cards = Array.from({ length: CLOSED_MAX + 5 }, (_, i) => ({
      ref: `acme/api#${i}`,
      projectId: 'core',
      title: '',
      url: '',
      labels: [],
      closedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    }))
    const out = newestClosed(cards)
    expect(out).toHaveLength(CLOSED_MAX)
    expect(out[0]?.ref).toBe(`acme/api#${CLOSED_MAX + 4}`)
  })
})

describe('ClosedCardsReader', () => {
  it('pide los cerrados del board (is:closed), pagina y ordena', async () => {
    const queries: string[] = []
    const pages = [
      {
        nodes: [item(1, '2026-01-01T10:00:00Z')],
        pageInfo: { hasNextPage: true, endCursor: 'c1' },
      },
      {
        nodes: [item(2, '2026-01-03T10:00:00Z')],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]
    const client = {
      graphql: async (query: string) => {
        queries.push(query)
        return { repositoryOwner: { projectV2: { items: pages[queries.length - 1] } } }
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: un cliente de GitHub de mentira con sólo graphql
    const reader = new ClosedCardsReader(client as any)
    const out = await reader.closed(spec)
    expect(queries).toHaveLength(2)
    expect(queries[0]).toContain('query: "is:closed"')
    expect(out.map((c) => c.ref)).toEqual(['acme/api#2', 'acme/api#1'])
  })
})
