import { describe, expect, it } from 'bun:test'
import type { BoardCard } from '@ia-flow/github-tools'
import type { Board } from './Board.js'
import { Boards, changedRefs } from './Boards.js'

const card = (ref: string, status = 'Build'): BoardCard =>
  ({
    ref,
    projectId: 'p',
    title: ref,
    url: '',
    status,
    labels: [],
    updatedAt: '',
    blockedBy: [],
  }) as BoardCard

/** Un board cuyas cards cambian entre lecturas; cuenta cuántas veces se leyó y se soltó su cache. */
function fakeBoard(reads: BoardCard[][]) {
  const state = { reads: 0, invalidations: 0 }
  const board = {
    projectId: 'p',
    cards: async () => reads[Math.min(state.reads++, reads.length - 1)] as BoardCard[],
    invalidate: () => {
      state.invalidations += 1
    },
  } as unknown as Board
  return { board, state }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('changedRefs', () => {
  it('las cards que cambiaron, aparecieron o se fueron', () => {
    const before = [card('o/r#1'), card('o/r#2'), card('o/r#3')]
    const after = [card('o/r#1'), card('o/r#2', 'Review'), card('o/r#4')]
    expect(changedRefs(before, after).sort()).toEqual(['o/r#2', 'o/r#3', 'o/r#4'])
    expect(changedRefs(before, before)).toEqual([])
  })
})

describe('Boards — la bandeja', () => {
  it('un webhook (markStale) no frena: sirve lo que tenía y avisa qué cambió al releer', async () => {
    const { board, state } = fakeBoard([[card('o/r#1')], [card('o/r#1', 'Review')]])
    const boards = new Boards([board])
    const changes: string[][] = []
    boards.onCardsChanged((refs) => changes.push(refs))

    expect((await boards.cards({ projectId: 'p' }))[0]?.status).toBe('Build')
    boards.markStale()
    expect((await boards.cards({ projectId: 'p' }))[0]?.status).toBe('Build')
    await tick()
    expect(changes).toEqual([['o/r#1']])
    expect((await boards.cards({ projectId: 'p' }))[0]?.status).toBe('Review')
    expect(state.reads).toBe(2)
    // Cada relectura es de verdad: suelta el cache corto del propio board antes de leer.
    expect(state.invalidations).toBe(2)
  })

  it('una relectura sin cambios no avisa', async () => {
    const { board } = fakeBoard([[card('o/r#1')]])
    const boards = new Boards([board])
    const changes: string[][] = []
    boards.onCardsChanged((refs) => changes.push(refs))
    await boards.cards({ projectId: 'p' })
    boards.markStale()
    await boards.cards({ projectId: 'p' })
    await tick()
    expect(changes).toEqual([])
  })

  it('invalidate: el próximo pedido espera el dato nuevo', async () => {
    const { board } = fakeBoard([[card('o/r#1')], [card('o/r#1', 'Done')]])
    const boards = new Boards([board])
    await boards.cards({ projectId: 'p' })
    boards.invalidate()
    expect((await boards.cards({ projectId: 'p' }))[0]?.status).toBe('Done')
  })
})
