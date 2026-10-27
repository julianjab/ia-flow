import { describe, expect, it } from 'bun:test'
import type { PipelineDecision } from '@ia-flow/shared'
import type { StoredEvent } from './ActivityPort.js'
import { blockersWait } from './blockersWait.js'
import type { BoardCard } from './classify.js'

const card = (patch: Partial<BoardCard> = {}): BoardCard => ({
  ref: 'la-haus/subscriptions#2041',
  projectId: 'lahaus-ai-flow',
  title: 'Un hijo de épica',
  url: 'https://github.com/la-haus/subscriptions/issues/2041',
  status: 'Refine',
  labels: ['epic-hold'],
  updatedAt: '2026-10-22T23:31:00Z',
  blockedBy: ['la-haus/subscriptions#2038'],
  ...patch,
})

const last: StoredEvent = {
  id: 'ev1',
  type: 'projects_v2_item.edited',
  payload: { fieldName: 'Working', item: { status: 'Backlog', blocked: true } },
}
const activity = (event: StoredEvent | undefined = last) => ({ lastDispatchedEvent: () => event })
const decision = (patch: Partial<PipelineDecision>): PipelineDecision => ({
  pipeline_id: 'refine',
  source_id: 'lahaus-ai-flow',
  verdict: 'ran',
  ...patch,
})

describe('blockersWait', () => {
  it('asks the engine with the card arriving at its column now', async () => {
    const seen: StoredEvent[] = []
    const waits = await blockersWait(card(), activity(), async (event) => {
      seen.push(event)
      return [decision({})]
    })
    expect(waits).toBe(false)
    expect(seen[0]).toMatchObject({
      id: 'blockers-ev1',
      type: 'issue.status_changed',
      payload: { to: 'Refine', item: { status: 'Refine', blocked: true } },
    })
  })

  it('waits when no pipeline of its project would run', async () => {
    const explain = async () => [
      decision({ verdict: 'mismatch', reason: 'item.blocked neq true (vino true)' }),
      // Una del runner (no del proyecto) que corre igual no cuenta.
      decision({ pipeline_id: 'intake', source_id: 'runner' }),
    ]
    expect(await blockersWait(card(), activity(), explain)).toBe(true)
  })

  it('without blockers, without a previous event or if explain fails, it waits as before', async () => {
    const never = async (): Promise<PipelineDecision[]> => {
      throw new Error('no debería preguntar')
    }
    expect(await blockersWait(card({ blockedBy: [] }), activity(), never)).toBe(true)
    expect(await blockersWait(card(), activity(undefined), never)).toBe(true)
    expect(await blockersWait(card(), activity(), never)).toBe(true)
  })
})
