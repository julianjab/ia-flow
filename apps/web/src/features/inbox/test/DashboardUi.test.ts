import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { item } from './fixtures'

const postTaskAction = vi.fn()
const getTasks = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getTasks: (...a: unknown[]) => getTasks(...a),
  getTaskDetail: vi.fn(),
  postTaskAction: (...a: unknown[]) => postTaskAction(...a),
}))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://ia-flow.ss.lahaus.com', url: (p: string) => p }),
}))

import { useGithubSessionStore } from '@/stores/githubSession'
import DashboardEditor from '../DashboardEditor.vue'
import DashboardPanels from '../DashboardPanels.vue'
import InboxCard from '../InboxCard.vue'
import RulesLegend from '../RulesLegend.vue'
import { useInboxStore } from '../store'
import TaskActions from '../TaskActions.vue'

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

  it('la tarjeta lleva el verbo del dashboard, sus chips con tono y el contexto', () => {
    const { pinia } = setup()
    const wrapper = mount(InboxCard, {
      props: {
        open: false,
        item: item({
          kind: 'merge',
          verb: 'Decidir el merge',
          chips: [{ text: 'a un merge de Done', tone: 'hot' }, { text: 'sin tono' }],
          context: 'Si el PR está bien, mergealo.',
        }),
      },
      global: { plugins: [pinia] },
    })
    expect(wrapper.find('.card__kind').text()).toBe('Decidir el merge')
    expect(
      wrapper.findAll('.card__tag').map((tag) => [tag.text(), tag.attributes('data-tone')]),
    ).toEqual([
      ['a un merge de Done', 'hot'],
      ['sin tono', undefined],
    ])
    expect(wrapper.find('.card__ctx').text()).toBe('Si el PR está bien, mergealo.')
  })

  it('sin verbo, la tarjeta usa el nombre del caso de siempre', () => {
    const { pinia } = setup()
    const wrapper = mount(InboxCard, {
      props: { open: false, item: item({ kind: 'merge' }) },
      global: { plugins: [pinia] },
    })
    expect(wrapper.find('.card__kind').text()).toBe('Listo para mergear')
  })

  it('la acción que destaca el dashboard es la primaria, aunque el caso diga otra', () => {
    const { pinia } = setup()
    const wrapper = mount(TaskActions, {
      props: {
        item: item({ kind: 'merge', actions: ['merge', 'rerun_review'], primary: 'rerun_review' }),
      },
      global: { plugins: [pinia] },
    })
    expect(wrapper.find('[data-action="rerun_review"]').classes()).toContain('btn--primary')
    expect(wrapper.find('[data-action="merge"]').classes()).not.toContain('btn--primary')
  })

  it('los paneles muestran el pipeline y lo que podría arrancar, y mover una card va con tu usuario', async () => {
    postTaskAction.mockResolvedValue({ ok: true, message: 'listo', github_login: 'ada' })
    const { pinia, store } = setup()
    await store.refresh()
    const wrapper = mount(DashboardPanels, {
      props: { view: store.view as NonNullable<typeof store.view> },
      global: { plugins: [pinia] },
    })
    expect(wrapper.text()).toContain('1 corriendo')
    expect(wrapper.text()).toContain('3 libres')
    expect(wrapper.text()).toContain('Tarea o/r#2')

    await wrapper.find('[data-feed-action="start_refine"]').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith('o/r#2', { action: 'start_refine' }, 'gho_1')
  })

  it('sin sesión de GitHub, mover una card pide el login y no manda nada', async () => {
    const { pinia, store, session } = setup()
    session.github = null
    await store.refresh()
    const wrapper = mount(DashboardPanels, {
      props: { view: store.view as NonNullable<typeof store.view> },
      global: { plugins: [pinia] },
    })
    await wrapper.find('[data-feed-action="start_refine"]').trigger('click')
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
    await wrapper.find('.btn--primary').trigger('click')
    expect(wrapper.find('[role="alert"]').text()).toContain('no cumple el formato')
    expect(store.dashboard?.source).toBe('preset')

    await textarea.setValue(store.dashboard?.text.replace('Decidir el merge', 'Mergear ya') ?? '')
    await wrapper.find('.btn--primary').trigger('click')
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
