import { describe, expect, it } from 'bun:test'
import { heldComments, isHumanComment, UserCommentLedger } from './heldComments.js'

describe('isHumanComment', () => {
  it('is a person without the engine mark', () => {
    expect(isHumanComment('cambiá el texto', 'julianjab')).toBe(true)
    expect(isHumanComment('Quality Gate passed', 'sonarqubecloud[bot]')).toBe(false)
    expect(isHumanComment('hola', 'renovate', 'Bot')).toBe(false)
    expect(isHumanComment('### reviewer <!-- ia-flow:report -->', 'julianjab')).toBe(false)
    expect(isHumanComment('hola', '')).toBe(false)
  })
})

describe('heldComments', () => {
  const at = (id: number, created_at: string, login = 'julian') => ({
    id,
    body: `c${id}`,
    created_at,
    user: { login },
  })

  it('keeps the human ones after `since`, oldest first, with their PR', () => {
    const held = heldComments(
      [
        { comments: [at(1, '2026-01-01T00:00:00Z'), at(3, '2026-01-03T00:00:00Z')] },
        {
          comments: [at(2, '2026-01-02T00:00:00Z'), at(4, '2026-01-04T00:00:00Z', 'x[bot]')],
          pr: 9,
        },
      ],
      '2026-01-01T12:00:00Z',
      () => false,
    )
    expect(held.map(({ id, pr }) => ({ id, pr }))).toEqual([
      { id: 2, pr: 9 },
      { id: 3, pr: undefined },
    ])
  })

  it('skips the ones the runner posted for someone, and those without an id', () => {
    const held = heldComments(
      [
        {
          comments: [
            at(5, '2026-01-05T00:00:00Z'),
            { ...at(6, '2026-01-06T00:00:00Z'), id: undefined },
          ],
        },
      ],
      '2026-01-01T00:00:00Z',
      (id) => id === 5,
    )
    expect(held).toEqual([])
  })
})

describe('UserCommentLedger', () => {
  it('remembers a posted comment for a while', () => {
    let now = 0
    const ledger = new UserCommentLedger(1_000, () => now)
    ledger.note(7)
    expect(ledger.has(7)).toBe(true)
    now = 2_000
    expect(ledger.has(7)).toBe(false)
  })
})
