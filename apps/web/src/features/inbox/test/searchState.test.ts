import type { BoardRest, Inbox, InboxItem } from '@ia-flow/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createSearch, SEARCH_DEBOUNCE_MS } from '@/features/inbox/state/search'

const item = (ref: string, title: string) =>
  ({ ref, title, url: `https://github.com/${ref}`, group: 'need' }) as unknown as InboxItem

function setup() {
  const loadRest = vi.fn(async () => {})
  const search = createSearch({
    scoped: ref([item('la-haus/ims#1', 'Perfilado del lead'), item('la-haus/ims#2', 'Otra cosa')]),
    inbox: ref<Inbox | null>(null),
    runner: ref<Inbox | null>(null),
    rest: ref<BoardRest | null>(null),
    loadRest,
    restLoading: ref(false),
  })
  return { search, loadRest }
}

describe('createSearch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('el campo muestra cada tecla al instante y el filtrado espera la pausa', () => {
    const { search } = setup()
    search.setSearchQuery('perf')
    expect(search.searchQuery.value).toBe('perf')
    expect(search.search.value).toBeNull()
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(search.searchHits.value.map((h) => h.ref)).toEqual(['la-haus/ims#1'])
  })

  it('sólo filtra lo último que se escribió', () => {
    const { search } = setup()
    search.setSearchQuery('perf')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS / 2)
    search.setSearchQuery('otra')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    expect(search.searchHits.value.map((h) => h.ref)).toEqual(['la-haus/ims#2'])
  })

  it('vaciarlo es inmediato', () => {
    const { search } = setup()
    search.setSearchQuery('perf')
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS)
    search.setSearchQuery('')
    expect(search.search.value).toBeNull()
  })

  it('pide el resto del board en la primera tecla, sin esperar la pausa', () => {
    const { search, loadRest } = setup()
    search.setSearchQuery('p')
    expect(loadRest).toHaveBeenCalledOnce()
  })
})
