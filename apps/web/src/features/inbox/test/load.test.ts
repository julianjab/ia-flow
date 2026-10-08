import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inbox, item } from '@/features/inbox/test/fixtures'

// La carga por sección (`state/load.ts` + `state/sections.ts`): /api/tasks y /api/inbox salen en
// paralelo, cada sección pinta con SU pedido, un error queda en su sección y un refresco no
// vuelve a «cargando».

const getInbox = vi.fn()
const getTasks = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  getInbox: (...a: unknown[]) => getInbox(...a),
  getTasks: (...a: unknown[]) => getTasks(...a),
  getTaskDetail: vi.fn(),
  postTaskAction: vi.fn(),
}))
vi.mock('@/features/inbox/stream', () => ({ connectRunnerStream: () => ({ close: vi.fn() }) }))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'http://r:1', token: 't', url: (p: string) => `http://r:1${p}` }),
}))

import { useInboxStore } from '@/features/inbox/store'

const need = item({ ref: 'acme/api#1', group: 'need', kind: 'merge' })

const facts = (ref: string, status: string, labels: string[] = []) => ({
  ref,
  project_id: 'p',
  title: ref,
  url: 'u',
  updated_at: '2026-09-29T08:00:00Z',
  item: { status, type: 'technical', repos: ['r'], labels, blocked: false },
  run: {},
  live: {},
  queue: { waiting: false },
  task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 0 },
  blocked_by_refs: [],
  actions: ['merge'],
  action_defs: [],
})
const published = {
  generated_at: 'x',
  projects: [],
  tasks: [facts('acme/api#1', 'Review', ['reviewed']), facts('acme/api#2', 'Backlog')],
  capacity: { running: 0, waiting: 0, paused: 0, max_concurrent: 2, free: 2 },
}

describe('la carga por sección', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.useFakeTimers()
    getTasks.mockReset()
    getInbox.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('cada sección pinta con SU pedido: las decisiones no esperan al feed del runner', async () => {
    getTasks.mockResolvedValue(published)
    let sendInbox: (v: unknown) => void = () => {}
    getInbox.mockReturnValue(new Promise((resolve) => (sendInbox = resolve)))
    const store = useInboxStore()
    const done = store.refresh()
    expect(store.sections).toMatchObject({ decisions: 'loading', feed: 'loading' })
    // /api/tasks y /api/inbox salen juntos, sin encadenarse.
    expect(getTasks).toHaveBeenCalledTimes(1)
    expect(getInbox).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.sections).toMatchObject({
      decisions: 'ready',
      epics: 'ready',
      pipeline: 'ready',
      feed: 'loading',
    })
    expect(store.queue.first?.ref).toBe('acme/api#1')
    sendInbox({
      ...inbox([]),
      feed: { ready: [{ ...facts('acme/api#5', 'Todo'), labels: [] }], waiting: [] },
    })
    await done
    expect(store.sections.feed).toBe('ready')
    expect(store.queue.feed?.entries.map((e) => e.ref)).toEqual(['acme/api#5'])
  })

  it('el feed pinta aunque /api/tasks siga cargando', async () => {
    getTasks.mockReturnValue(new Promise(() => {}))
    getInbox.mockResolvedValue({ ...inbox([]), feed: { ready: [], waiting: [] } })
    const store = useInboxStore()
    void store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.sections).toMatchObject({ decisions: 'loading', feed: 'ready' })
  })

  it('si falla el feed del runner, el error es del feed: las decisiones pintan', async () => {
    getTasks.mockResolvedValue(published)
    getInbox.mockRejectedValue(new Error('runner lento'))
    const store = useInboxStore()
    await store.refresh()
    expect(store.sections).toMatchObject({ decisions: 'ready', feed: 'error' })
    expect(store.runnerError).toBe('runner lento')
    expect(store.error).toBeNull()
  })

  it('un refresco no vuelve a «cargando»: se mantiene lo pintado hasta tener lo nuevo', async () => {
    getTasks.mockResolvedValue(published)
    getInbox.mockResolvedValue({ ...inbox([]), feed: { ready: [], waiting: [] } })
    const store = useInboxStore()
    await store.refresh()
    getTasks.mockReturnValue(new Promise(() => {}))
    getInbox.mockReturnValue(new Promise(() => {}))
    void store.refresh()
    await vi.advanceTimersByTimeAsync(0)
    expect(Object.values(store.sections)).not.toContain('loading')
    expect(store.loading).toBe(false)
    expect(store.queue.first?.ref).toBe('acme/api#1')
  })

  it('un refresco que falla no borra lo pintado', async () => {
    getTasks.mockResolvedValue(published)
    const store = useInboxStore()
    await store.refresh()
    getTasks.mockRejectedValue(new Error('se cayó'))
    await store.refresh()
    expect(store.error).toBe('se cayó')
    expect(store.sections.decisions).toBe('ready')
    expect(store.queue.first?.ref).toBe('acme/api#1')
  })

  it('un runner viejo (404 en /api/tasks) usa el MISMO pedido a /api/inbox que el feed', async () => {
    getTasks.mockResolvedValue(null)
    getInbox.mockResolvedValue(inbox([need]))
    const store = useInboxStore()
    await store.refresh()
    expect(getInbox).toHaveBeenCalledTimes(1)
    expect(store.sections).toMatchObject({ decisions: 'ready', feed: 'ready' })
    expect(store.queue.first?.ref).toBe(need.ref)
    // Un runner que no manda `feed` no tiene sección de feed.
    expect(store.queue.feed).toBeNull()
  })
})
