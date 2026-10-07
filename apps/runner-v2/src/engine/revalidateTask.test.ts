import { describe, expect, it } from 'bun:test'
import { createEvent } from '@ia-flow/agent-engine'
import type { BoardCard } from '@ia-flow/github-tools'
import type { Boards } from '../board/Boards.js'
import { revalidateTask, withCard } from './revalidateTask.js'

const REF = 'la-haus/subscriptions#1763'
const SCOPE = { projectId: 'p', repo: 'la-haus/subscriptions', issue: REF }

const card = (over: Partial<BoardCard> = {}): BoardCard => ({
  ref: REF,
  projectId: 'p',
  title: 'refactor(client-api): migrate the IMS permission gates',
  url: 'https://github.com/la-haus/subscriptions/issues/1763',
  status: 'Build',
  taskType: 'technical',
  labels: ['backend', 'e2e-test'],
  updatedAt: '2026-10-06T23:21:37Z',
  blockedBy: [],
  ...over,
})

/** El payload como lo arma el intake: `item.*` y su espejo en `event.payload`. */
function labeled() {
  const payload = {
    label: 'e2e-test',
    item: {
      status: 'Review',
      type: 'technical',
      repos: ['subscriptions'],
      labels: ['backend'],
      blocked: false,
    },
    task: { id: REF },
  }
  return createEvent(
    'issue.labeled',
    { ...payload, event: { payload: { ...payload } } },
    { scope: SCOPE },
  )
}

function boardsWith(cards: BoardCard[]) {
  const calls: string[] = []
  const board = {
    invalidate: () => calls.push('invalidate'),
    cards: async () => {
      calls.push('cards')
      return cards
    },
  }
  return { boards: { of: () => board } as unknown as Pick<Boards, 'of'>, calls }
}

describe('revalidateTask', () => {
  it('pone la card de ahora en item.* y en su espejo, y deja el resto del evento', () => {
    const event = labeled()
    const fresh = withCard(event, card({ blockedBy: ['la-haus/ims-backend#9'] }))
    const item = {
      status: 'Build',
      type: 'technical',
      repos: ['subscriptions'],
      labels: ['backend', 'e2e-test'],
      blocked: true,
    }
    expect(fresh.payload).toMatchObject({ label: 'e2e-test', task: { id: REF }, item })
    expect((fresh.payload as { event: { payload: unknown } }).event.payload).toMatchObject({ item })
    expect(fresh.id).toBe(event.id)
    expect(fresh.scope).toEqual(SCOPE)
  })

  it('relee el board sin cache y devuelve la card de la task', async () => {
    const { boards, calls } = boardsWith([card({ ref: 'otra/cosa#1' }), card()])
    const fresh = await revalidateTask(boards)(labeled())
    expect(calls).toEqual(['invalidate', 'cards'])
    expect(fresh?.payload).toMatchObject({ item: { status: 'Build' } })
  })

  it('una task que ya no está en el board, o un evento que no es de una task: no se sabe', async () => {
    const { boards } = boardsWith([card({ ref: 'otra/cosa#1' })])
    expect(await revalidateTask(boards)(labeled())).toBeUndefined()
    expect(await revalidateTask(boards)(createEvent('github.issues', {}, {}))).toBeUndefined()
  })
})
