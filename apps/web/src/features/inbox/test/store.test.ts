import type { RunnerStreamEvent } from '@ia-flow/shared'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { detail, execution, inbox, item, trace } from '@/features/inbox/test/fixtures'

const getInbox = vi.fn()
const getTasks = vi.fn()
const getTaskDetail = vi.fn()
const postTaskAction = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  getInbox: (...a: unknown[]) => getInbox(...a),
  getTasks: (...a: unknown[]) => getTasks(...a),
  getTaskDetail: (...a: unknown[]) => getTaskDetail(...a),
  postTaskAction: (...a: unknown[]) => postTaskAction(...a),
}))

let emit: (e: RunnerStreamEvent) => void = () => {}
let poll: () => void = () => {}
const close = vi.fn()
let streamUrl = ''

vi.mock('@/features/inbox/stream', () => ({
  connectRunnerStream: (o: { url: () => string; onEvent: typeof emit; onPoll: () => void }) => {
    streamUrl = o.url()
    emit = o.onEvent
    poll = o.onPoll
    return { close }
  },
}))

vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({
    base: 'http://r:1',
    token: 'tok en',
    url: (p: string) => `http://r:1${p}`,
  }),
}))

import { useInboxStore } from '@/features/inbox/store'

const need = item({ ref: 'acme/api#1', group: 'need', kind: 'merge' })
const fail = item({ ref: 'acme/api#2', group: 'fail', kind: 'crash', actions: ['retry'] })
const run = item({
  ref: 'other/web#3',
  project_id: 'web',
  group: 'run',
  kind: 'agent',
  actions: ['stop'],
  execution: execution(),
})

const projects = [
  { id: 'core', board: { owner: 'acme', number: 1 } },
  { id: 'web', board: { owner: 'other', number: 2 } },
]

describe('useInboxStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
    // Por defecto, un runner viejo: sin /api/tasks, la bandeja viene clasificada.
    getTasks.mockReset().mockResolvedValue(null)
    getInbox.mockReset().mockResolvedValue(inbox([need, fail, run], projects))
    getTaskDetail.mockReset().mockImplementation(async (ref: string) => detail(item({ ref })))
    postTaskAction.mockReset()
    close.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('carga la bandeja como cola: decisiones (need y fail) y lo que corre como número', async () => {
    const store = useInboxStore()
    await store.refresh()
    expect(store.queue.headline).toEqual({ decisions: 2, tasks: 2, failed: 1 })
    expect(store.queue.first?.ref).toBe(need.ref)
    expect(store.queue.pipeline).toMatchObject({ running: 1, waiting: 0, source: 'items' })
    expect(store.loading).toBe(false)
  })

  it('el filtro de proyecto acota la cola sin volver a pedir', async () => {
    const store = useInboxStore()
    await store.refresh()
    store.project = 'web'
    expect(store.queue.headline.decisions).toBe(0)
    expect(store.queue.pipeline.running).toBe(1)
    expect(store.total).toBe(1)
    expect(getInbox).toHaveBeenCalledTimes(1)
  })

  it('un proyecto que desaparece deja de filtrar', async () => {
    const store = useInboxStore()
    await store.refresh()
    store.project = 'web'
    getInbox.mockResolvedValue(inbox([need], [projects[0] as (typeof projects)[0]]))
    await store.refresh()
    expect(store.project).toBeNull()
  })

  it('un error conserva lo que ya se veía y lo reporta', async () => {
    const store = useInboxStore()
    await store.refresh()
    getInbox.mockRejectedValue(new Error('runner caído'))
    await store.refresh()
    expect(store.error).toBe('runner caído')
    expect(store.inbox?.items).toHaveLength(3)
  })

  it('abrir una tarjeta carga su detalle; abrirla otra vez la cierra', async () => {
    const store = useInboxStore()
    await store.refresh()
    store.toggle(need.ref)
    expect(store.openRef).toBe(need.ref)
    await vi.waitFor(() => expect(store.details[need.ref]?.data).not.toBeNull())
    store.toggle(need.ref)
    expect(store.openRef).toBeNull()
  })

  it('focus (pedido del asistente) abre la tarea y suelta los filtros que la esconderían', async () => {
    const store = useInboxStore()
    await store.refresh()
    store.project = 'core'
    store.setQueueFilter('merge')
    store.focus('other/web#3')
    expect(store.queueFilter).toBeNull()
    expect(store.project).toBeNull()
    expect(store.openRef).toBe('other/web#3')
    expect(getTaskDetail).toHaveBeenCalledWith('other/web#3')
    // Otra vez la misma: queda abierta (no es un toggle).
    store.focus('other/web#3')
    expect(store.openRef).toBe('other/web#3')
  })

  it('expand abre la tarea en grande (y la carga si no estaba abierta); cerrar la tarjeta lo suelta', async () => {
    const store = useInboxStore()
    await store.refresh()
    store.expand('acme/api#2')
    expect(store.openRef).toBe('acme/api#2')
    expect(store.expanded).toBe(true)
    expect(getTaskDetail).toHaveBeenCalledWith('acme/api#2')
    store.collapse()
    expect(store.expanded).toBe(false)
    expect(store.openRef).toBe('acme/api#2')
    store.expand('acme/api#2')
    store.toggle('acme/api#2')
    expect(store.expanded).toBe(false)
    expect(store.openRef).toBeNull()
  })

  it('un error de detalle queda en su tarjeta', async () => {
    getTaskDetail.mockRejectedValue(new Error('404'))
    const store = useInboxStore()
    await store.loadDetail(need.ref)
    expect(store.details[need.ref]).toMatchObject({ loading: false, error: '404', data: null })
  })

  it('runAction manda el token y, si salió bien, refresca la bandeja', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'Mergeado', github_login: 'ada' })
    const store = useInboxStore()
    await store.refresh()
    getInbox.mockClear()
    const result = await store.runAction(need.ref, 'merge', 'gho_1')
    expect(postTaskAction).toHaveBeenCalledWith(need.ref, { action: 'merge' }, 'gho_1')
    expect(result?.ok).toBe(true)
    expect(store.actions[need.ref]?.result?.message).toBe('Mergeado')
    expect(getInbox).toHaveBeenCalledTimes(1)
  })

  it('un comentario viaja sólo cuando lo hay; un rechazo no refresca', async () => {
    postTaskAction.mockResolvedValue({ ok: false, message: 'Sin permisos' })
    const store = useInboxStore()
    await store.refresh()
    getInbox.mockClear()
    await store.runAction(need.ref, 'answer_and_unblock', 't', 'Son 90 días')
    expect(postTaskAction).toHaveBeenCalledWith(
      need.ref,
      { action: 'answer_and_unblock', comment: 'Son 90 días' },
      't',
    )
    expect(store.actions[need.ref]?.result?.ok).toBe(false)
    expect(getInbox).not.toHaveBeenCalled()
  })

  it('la cola sale del inbox viejo: sin capacity cuenta las tarjetas que corren', async () => {
    const store = useInboxStore()
    await store.refresh()
    expect(store.queue.first?.ref).toBe(need.ref)
    expect(store.queue.headline).toEqual({ decisions: 2, tasks: 2, failed: 1 })
    expect(store.queue.pipeline).toEqual({ running: 1, waiting: 0, source: 'items' })
    expect(store.queue.feed).toBeNull()
    store.project = 'web'
    expect(store.queue.first).toBeNull()
  })

  it('runActionSeries corre la acción de un grupo en serie y corta en la primera que falla', async () => {
    postTaskAction
      .mockResolvedValueOnce({ ok: true, message: 'ok' })
      .mockResolvedValueOnce({ ok: false, message: 'Sin permisos' })
    const store = useInboxStore()
    await store.refresh()
    const ok = await store.runActionSeries(['a/b#1', 'a/b#2', 'a/b#3'], 'merge', 't')
    expect(ok).toBe(false)
    expect(postTaskAction.mock.calls.map((c) => c[0])).toEqual(['a/b#1', 'a/b#2'])
    expect(store.actions['a/b#2']?.result?.message).toBe('Sin permisos')
  })

  it('un fallo de red en la acción queda como error de esa tarjeta', async () => {
    postTaskAction.mockRejectedValue(new Error('sin red'))
    const store = useInboxStore()
    expect(await store.runAction(need.ref, 'merge', 't')).toBeNull()
    expect(store.actions[need.ref]).toMatchObject({ pending: false, error: 'sin red' })
  })

  describe('en vivo', () => {
    it('start conecta al stream con el token en la query, url-encoded, y stop lo corta', async () => {
      const store = useInboxStore()
      store.start()
      expect(streamUrl).toBe('http://r:1/api/stream?token=tok%20en')
      store.start()
      expect(close).not.toHaveBeenCalled()
      store.stop()
      expect(close).toHaveBeenCalledTimes(1)
    })

    it('un evento inbox refresca (con debounce) y recarga el detalle abierto si lo toca', async () => {
      const store = useInboxStore()
      store.start()
      await vi.advanceTimersByTimeAsync(0)
      getInbox.mockClear()
      store.openRef = need.ref
      emit({ type: 'inbox', refs: [need.ref] })
      emit({ type: 'inbox', refs: [need.ref] })
      await vi.advanceTimersByTimeAsync(300)
      expect(getInbox).toHaveBeenCalledTimes(1)
      expect(getTaskDetail).toHaveBeenCalledWith(need.ref)
    })

    it('las líneas de traza de la ejecución abierta se suman en vivo; las de otra no', async () => {
      const store = useInboxStore()
      store.start()
      store.openRef = run.ref
      getTaskDetail.mockResolvedValue(detail(run, { trace: [trace({ execution_id: 'ex1' })] }))
      await store.loadDetail(run.ref)

      emit({ type: 'trace', entry: trace({ name: 'nueva', span_id: 's2', execution_id: 'ex1' }) })
      emit({ type: 'trace', entry: trace({ name: 'ajena', span_id: 's3', execution_id: 'otra' }) })
      expect(store.details[run.ref]?.data?.trace.map((t) => t.name)).toEqual([
        'fs_read src/index.ts',
        'nueva',
      ])
    })

    it('el polling de respaldo refresca la bandeja', async () => {
      const store = useInboxStore()
      store.start()
      await vi.advanceTimersByTimeAsync(0)
      getInbox.mockClear()
      poll()
      // El runner viejo se descubre con /api/tasks (404) y recién ahí se pide /api/inbox.
      await vi.advanceTimersByTimeAsync(0)
      expect(getInbox).toHaveBeenCalledTimes(1)
    })
  })
  describe('con un runner que publica los hechos', () => {
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

    beforeEach(() => localStorage.clear())

    it('la bandeja sale de aplicar el dashboard a los hechos; /api/inbox sólo trae el feed', async () => {
      getTasks.mockResolvedValue(published)
      const store = useInboxStore()
      await store.refresh()
      // El dashboard por defecto no define el feed: lo pone el runner, pedido en paralelo.
      expect(getInbox).toHaveBeenCalledTimes(1)
      expect(store.inbox?.items.map((i) => [i.ref, i.kind, i.actions])).toEqual([
        ['acme/api#1', 'merge', ['merge']],
      ])
      expect(store.dashboard?.source).toBe('default')
      expect(store.view?.capacity).toMatchObject({ free: 2 })
      expect(store.queue.pipeline).toEqual({
        running: 0,
        waiting: 0,
        free: 2,
        max: 2,
        source: 'capacity',
      })
      expect(store.queue.first?.short).toBe('api#1')
    })

    it('guardar un dashboard lo aplica ya, sin volver a pedir nada al runner', async () => {
      getTasks.mockResolvedValue(published)
      const store = useInboxStore()
      await store.refresh()
      const text = store.dashboard?.text ?? ''
      const edited = text.replace(
        'kind: merge\n    weight: 100',
        'kind: merge\n    verb: Mergear ya\n    weight: 100',
      )
      expect(store.saveDashboard(edited)).toBeNull()
      expect(getTasks).toHaveBeenCalledTimes(1)
      expect(store.dashboard?.source).toBe('override')
      expect(store.inbox?.items[0]?.verb).toBe('Mergear ya')
      store.resetDashboard()
      expect(store.dashboard?.source).toBe('default')
      expect(store.inbox?.items[0]?.verb).toBeUndefined()
    })

    it('un dashboard inválido no se guarda y dice por qué', async () => {
      getTasks.mockResolvedValue(published)
      const store = useInboxStore()
      await store.refresh()
      expect(store.saveDashboard('decisions: []')).toContain('no cumple el formato')
      expect(store.dashboard?.source).toBe('default')
    })
  })
})
