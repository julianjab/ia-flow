import { describe, expect, it } from 'vitest'
import { boardIndex } from '@/features/inbox/queue/boardIndex'
import { item } from '@/features/inbox/test/fixtures'

const card = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  project_id: 'core',
  title: ref,
  url: `https://github.com/${ref.replace('#', '/issues/')}`,
  labels: [],
  updated_at: '2026-10-01T10:00:00Z',
  ...over,
})

describe('boardIndex', () => {
  it('junta la bandeja, «Por arrancar» y el resto del board con su columna, sin mayúsculas', () => {
    const index = boardIndex({
      items: [item({ ref: 'Acme/API#7', status: 'Review' })],
      feed: [card('acme/web#3')],
      rest: [{ status: 'Done', items: [card('acme/web#5')] }],
    })
    expect(index.get('acme/api#7')).toEqual({ ref: 'Acme/API#7', status: 'Review' })
    expect(index.get('acme/web#3')).toEqual({ ref: 'acme/web#3', status: 'Todo' })
    expect(index.get('acme/web#5')).toEqual({ ref: 'acme/web#5', status: 'Done' })
  })

  it('el PR de una tarea apunta a la tarea; lo primero que se ve gana', () => {
    const index = boardIndex({
      items: [
        item({
          ref: 'acme/api#7',
          status: 'Review',
          pr: { number: 12, url: 'https://github.com/acme/api/pull/12' },
        }),
        item({ ref: 'acme/api#8', status: undefined, pr: { number: 13, url: 'raro' } }),
      ],
      feed: [],
      rest: [{ status: 'Done', items: [card('acme/api#7')] }],
    })
    expect(index.get('acme/api#12')).toEqual({ ref: 'acme/api#7', status: 'Review' })
    expect(index.get('acme/api#13')).toEqual({ ref: 'acme/api#8', status: '' })
    expect(index.get('acme/api#7')?.status).toBe('Review')
  })
})
