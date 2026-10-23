import { describe, expect, it } from 'bun:test'
import type { BoardCard } from '@ia-flow/github-tools'
import { withBuiltBlockers } from './stacking.js'

const card = (ref: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  ref,
  projectId: 'p',
  title: ref,
  url: '',
  labels: [],
  updatedAt: '',
  blockedBy: [],
  ...extra,
})

describe('withBuiltBlockers', () => {
  const cards = [
    card('o/r#1', { pr: { number: 10, url: '' } }),
    card('o/r#2'),
    card('o/r#3', { labels: ['epic-early'], blockedBy: ['o/r#1', 'o/r#2', 'o/x#9'] }),
    card('o/r#4', { blockedBy: ['o/r#1'] }),
  ]

  it('con el label, un blocker con PR abierto deja de contar', () => {
    const [, , stacked, plain] = withBuiltBlockers(cards, 'epic-early')
    expect(stacked?.blockedBy).toEqual(['o/r#2', 'o/x#9'])
    expect(plain?.blockedBy).toEqual(['o/r#1'])
  })

  it('sin stacking en el proyecto, las cards quedan como están', () => {
    expect(withBuiltBlockers(cards, undefined)).toBe(cards)
  })
})
