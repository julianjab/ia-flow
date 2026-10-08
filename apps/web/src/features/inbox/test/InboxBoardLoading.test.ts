import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { inbox } from '@/features/inbox/test/fixtures'

// La bandeja carga por sección: cada una pinta con SU dato y muestra su esqueleto mientras tanto.

const getInbox = vi.fn()
const getTasks = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  getInbox: (...a: unknown[]) => getInbox(...a),
  getTasks: (...a: unknown[]) => getTasks(...a),
  getTaskDetail: vi.fn(),
  getBoardRest: vi.fn().mockReturnValue(new Promise(() => {})),
  postTaskAction: vi.fn(),
  explainTask: vi.fn(),
}))
vi.mock('@/features/inbox/stream', () => ({ connectRunnerStream: () => ({ close: vi.fn() }) }))
const split = ref(true)
vi.mock('@/composables/useIsMobile', () => ({
  useIsSplit: () => ({ isSplit: split }),
  useIsMobile: () => ({ isMobile: ref(false) }),
}))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://runner.test', url: (p: string) => p }),
}))

import InboxBoard from '@/features/inbox/InboxBoard.vue'

async function mountBoard() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(InboxBoard, { global: { plugins: [pinia] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, pinia }
}

describe('InboxBoard — carga por sección', () => {
  const published = {
    generated_at: 'x',
    projects: [],
    tasks: [
      {
        ref: 'acme/api#1',
        project_id: 'core',
        title: 'Listo para mergear',
        url: 'https://github.com/acme/api/issues/1',
        updated_at: '2026-01-01T10:00:00Z',
        item: { status: 'Review', type: 't', repos: [], labels: ['reviewed'], blocked: false },
        run: {},
        live: {},
        queue: { waiting: false },
        task: { idle_hours: 1, waiting_hours: 1, unlocks: 0, blocked_by: 0 },
        blocked_by_refs: [],
        actions: ['merge'],
        action_defs: [],
      },
    ],
    capacity: { running: 0, waiting: 0, paused: 0, max_concurrent: 2, free: 2 },
  }
  const runnerInbox = {
    ...inbox([]),
    feed: {
      ready: [
        {
          ref: 'acme/api#5',
          project_id: 'core',
          title: 'Lista para arrancar',
          url: 'https://github.com/acme/api/issues/5',
          labels: [],
          updated_at: 'x',
        },
      ],
      waiting: [],
    },
  }

  beforeEach(() => {
    localStorage.clear()
    split.value = true
    getTasks.mockReset()
    getInbox.mockReset()
  })

  it('las decisiones y el pipeline pintan mientras el feed sigue en esqueleto', async () => {
    getTasks.mockResolvedValue(published)
    let sendInbox: (v: unknown) => void = () => {}
    getInbox.mockReturnValue(new Promise((resolve) => (sendInbox = resolve)))
    const { wrapper } = await mountBoard()
    expect(wrapper.get('[data-test="first"]').text()).toContain('Listo para mergear')
    expect(wrapper.find('[data-test="cell-free"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="skeleton-queue"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="skeleton-feed"]').attributes('aria-busy')).toBe('true')

    sendInbox(runnerInbox)
    await flushPromises()
    expect(wrapper.find('[data-test="skeleton-feed"]').exists()).toBe(false)
    const feed = wrapper.get('[data-test="feed"]')
    expect(feed.text()).toContain('Qué le das al pipeline')
    expect(feed.text()).toContain('Lista para arrancar')
    expect(feed.attributes('id')).toBe('pipeline-feed')
  })

  it('el feed pinta aunque las decisiones sigan cargando', async () => {
    getTasks.mockReturnValue(new Promise(() => {}))
    getInbox.mockResolvedValue(runnerInbox)
    const { wrapper } = await mountBoard()
    expect(wrapper.find('[data-test="skeleton-queue"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="skeleton-pipeline"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="feed"]').text()).toContain('Lista para arrancar')
  })

  it('lo que llega aparece con `.reveal` en la primera carga', async () => {
    getTasks.mockResolvedValue(published)
    getInbox.mockResolvedValue(runnerInbox)
    const { wrapper } = await mountBoard()
    expect(wrapper.get('[data-test="first"]').classes()).toContain('reveal')
  })

  it('un refresco no vuelve al esqueleto: lo pintado se queda', async () => {
    getTasks.mockResolvedValue(published)
    getInbox.mockResolvedValue(runnerInbox)
    const { wrapper } = await mountBoard()
    getTasks.mockReturnValue(new Promise(() => {}))
    getInbox.mockReturnValue(new Promise(() => {}))
    const { useInboxStore } = await import('@/features/inbox/store')
    void useInboxStore().refresh()
    await flushPromises()
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="first"]').text()).toContain('Listo para mergear')
    expect(wrapper.get('[data-test="feed"]').text()).toContain('Lista para arrancar')
  })

  it('si falla sólo el feed, su error queda en su lugar y las decisiones se ven', async () => {
    getTasks.mockResolvedValue(published)
    getInbox.mockRejectedValue(new Error('timeout'))
    const { wrapper } = await mountBoard()
    expect(wrapper.get('[data-test="first"]').text()).toContain('Listo para mergear')
    expect(wrapper.get('[role="alert"]').text()).toContain('timeout')
  })
})
