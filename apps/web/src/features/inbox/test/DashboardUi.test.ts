import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { item } from '@/features/inbox/test/fixtures'

const postTaskAction = vi.fn()
const getTasks = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getTasks: (...a: unknown[]) => getTasks(...a),
  getTaskDetail: vi.fn(),
  getBoardRest: vi.fn().mockResolvedValue({ columns: [] }),
  postTaskAction: (...a: unknown[]) => postTaskAction(...a),
}))
vi.mock('@/features/inbox/stream', () => ({ connectRunnerStream: () => ({ close: vi.fn() }) }))
vi.mock('@/composables/useIsMobile', () => ({
  useIsSplit: () => ({ isSplit: ref(true) }),
  useIsMobile: () => ({ isMobile: ref(false) }),
}))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://ia-flow.ss.lahaus.com', url: (p: string) => p }),
}))

import DashboardEditor from '@/features/inbox/DashboardEditor.vue'
import DecisionRow from '@/features/inbox/decisions/DecisionRow.vue'
import InboxBoard from '@/features/inbox/InboxBoard.vue'
import FeedList from '@/features/inbox/pipeline/FeedList.vue'
import { buildQueue } from '@/features/inbox/queue/build'
import RulesLegend from '@/features/inbox/RulesLegend.vue'
import { useInboxStore } from '@/features/inbox/store'
import TaskActions from '@/features/inbox/TaskActions.vue'
import { useGithubSessionStore } from '@/stores/githubSession'

const fact = (ref: string, status: string, patch: Record<string, unknown> = {}) => ({
  ref,
  project_id: 'p',
  title: `Tarea ${ref}`,
  url: `https://github.com/${ref}`,
  updated_at: '2026-09-29T08:00:00Z',
  item: { status, type: 'technical', repos: ['r'], labels: [], blocked: false },
  run: {},
  live: {},
  queue: { waiting: false },
  task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 0 },
  blocked_by_refs: [],
  actions: [],
  action_defs: [],
  ...patch,
})

const published = {
  generated_at: 'x',
  projects: [],
  tasks: [
    fact('o/r#1', 'Review', {
      item: { status: 'Review', type: 't', repos: [], labels: ['reviewed'], blocked: false },
      pr: { number: 9, url: 'u' },
      actions: ['merge'],
      task: { idle_hours: 1, waiting_hours: 1, unlocks: 2, blocked_by: 0 },
    }),
    fact('o/r#2', 'Todo', {
      actions: ['start_refine'],
      action_defs: [{ id: 'start_refine', label: 'Mover a Refine' }],
    }),
  ],
  capacity: { running: 1, waiting: 0, paused: 0, max_concurrent: 4, free: 3 },
}

function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const session = useGithubSessionStore()
  session.github = { token: 'gho_1', login: 'ada' }
  return { pinia, session, store: useInboxStore() }
}

describe('el dashboard en la pantalla', () => {
  beforeEach(() => {
    localStorage.clear()
    postTaskAction.mockReset()
    getTasks.mockReset().mockResolvedValue(published)
  })

  it('la fila lleva el verbo del dashboard y sus chips como razones, con tono', () => {
    const { pinia } = setup()
    const queue = buildQueue({
      items: [
        item({ ref: 'o/r#0', kind: 'prd', actions: ['approve_prd'] }),
        item({
          kind: 'merge',
          verb: 'Decidir el merge',
          chips: [{ text: 'a un merge de Done', tone: 'hot' }, { text: 'sin tono' }],
          context: 'Si el PR está bien, mergealo.',
        }),
      ],
      now: Date.parse('2026-01-02T00:00:00Z'),
    })
    const wrapper = mount(DecisionRow, {
      props: { row: queue.rest[0] as (typeof queue.rest)[0] },
      global: { plugins: [pinia] },
    })
    expect(wrapper.get('.dr__verb').text()).toBe('✓Decidir el merge')
    expect(wrapper.findAll('.why').map((tag) => [tag.text(), tag.attributes('data-tone')])).toEqual(
      [
        ['a un merge de Done', 'hot'],
        ['sin tono', undefined],
      ],
    )
  })

  it('la acción que destaca el dashboard va primera, aunque el caso diga otra', () => {
    const { pinia } = setup()
    const wrapper = mount(TaskActions, {
      props: {
        item: item({ kind: 'merge', actions: ['merge', 'rerun_review'], primary: 'rerun_review' }),
      },
      global: { plugins: [pinia] },
    })
    const ids = wrapper.findAll('[data-action]').map((b) => b.attributes('data-action'))
    expect(ids).toEqual(['rerun_review', 'merge'])
  })

  it('desde 1100 px, el pipeline tiene su celda de libres y el feed dice cuántos lugares hay para llenar', async () => {
    const { pinia } = setup()
    const wrapper = mount(InboxBoard, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.get('[data-test="cell-free"]').text()).toContain('3')
    const feed = wrapper.get('[data-test="feed"] summary').text()
    expect(feed).toContain('3 lugares libres')
    expect(feed).toContain('1 lista para correr')
    wrapper.unmount()
  })

  it('la cola trae el pipeline y lo que podría arrancar, y mover una card va con tu usuario', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'listo', github_login: 'ada' })
    const { pinia, store } = setup()
    await store.refresh()
    expect(store.queue.pipeline).toMatchObject({ running: 1, waiting: 0, free: 3, max: 4 })
    const feed = store.queue.feed as NonNullable<typeof store.queue.feed>
    const wrapper = mount(FeedList, { props: { feed }, global: { plugins: [pinia] } })
    expect(wrapper.get('summary').text()).toContain('1 lista')
    expect(wrapper.text()).toContain('Tarea o/r#2')

    await wrapper.get('[data-action="start_refine"] button').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith('o/r#2', { action: 'start_refine' }, 'gho_1')
  })

  it('sin sesión de GitHub, mover una card pide el login y no manda nada', async () => {
    const { pinia, store, session } = setup()
    session.github = null
    await store.refresh()
    const feed = store.queue.feed as NonNullable<typeof store.queue.feed>
    const wrapper = mount(FeedList, { props: { feed }, global: { plugins: [pinia] } })
    await wrapper.get('[data-action="start_refine"] button').trigger('click')
    await flushPromises()
    expect(postTaskAction).not.toHaveBeenCalled()
  })

  it('el editor guarda un dashboard válido, rechaza uno inválido y vuelve al de la web', async () => {
    const { pinia, store } = setup()
    await store.refresh()
    expect(store.dashboard?.source).toBe('preset')
    const wrapper = mount(DashboardEditor, { global: { plugins: [pinia] } })
    expect(wrapper.text()).toContain('el que trae la web para este runner')

    const textarea = wrapper.find('textarea')
    await textarea.setValue('decisions: []')
    await wrapper.find('[data-test="save"]').trigger('click')
    expect(wrapper.find('[role="alert"]').text()).toContain('no cumple el formato')
    expect(store.dashboard?.source).toBe('preset')

    await textarea.setValue(store.dashboard?.text.replace('Decidir el merge', 'Mergear ya') ?? '')
    await wrapper.find('[data-test="save"]').trigger('click')
    expect(wrapper.find('[role="status"]').text()).toContain('Guardado')
    expect(store.dashboard?.source).toBe('override')
    expect(store.inbox?.items[0]?.verb).toBe('Mergear ya')

    await wrapper
      .findAll('.btn')
      .find((b) => b.text() === 'Volver al de la web')
      ?.trigger('click')
    expect(store.dashboard?.source).toBe('preset')
    expect(store.inbox?.items[0]?.verb).toBe('Decidir el merge')
  })

  it('la leyenda lista las decisiones del dashboard en el orden en que se evalúan', async () => {
    const { pinia, store } = setup()
    await store.refresh()
    const wrapper = mount(RulesLegend, { global: { plugins: [pinia] } })
    const names = wrapper.findAll('.lg__group').map((el) => el.text())
    expect(names.indexOf('Decidir el merge')).toBeLessThan(names.indexOf('Aprobar el PRD'))
    expect(names.at(-1)).toBe('Orden')
  })
})
