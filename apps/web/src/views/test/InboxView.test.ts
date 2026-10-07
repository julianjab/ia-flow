import type { InboxItem } from '@ia-flow/shared'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// La pantalla de la bandeja entera (la cola y, debajo, las mejoras): un solo primario, el de
// «Lo primero». Las mejoras se dibujan con botones normales.

const item = (over: Partial<InboxItem>): InboxItem => ({
  ref: 'acme/api#1',
  project_id: 'core',
  title: 'Listo para mergear',
  url: 'https://github.com/acme/api/pull/1',
  group: 'need',
  kind: 'merge',
  status: 'Review',
  labels: [],
  why: 'CI verde',
  since: '2026-01-01T10:00:00.000Z',
  actions: ['merge'],
  ...over,
})

vi.mock('@/features/inbox/api', () => ({
  getInbox: async () => ({
    generated_at: '2026-01-01T10:05:00.000Z',
    projects: [{ id: 'core', board: { owner: 'acme', number: 1 } }],
    items: [
      item({}),
      item({ ref: 'acme/api#2', kind: 'prd', title: 'Un PRD', actions: ['approve_prd'] }),
    ],
  }),
  getTasks: async () => null,
  getTaskDetail: vi.fn(),
  getBoardRest: vi.fn(),
  postTaskAction: vi.fn(),
  explainTask: vi.fn(),
}))
vi.mock('@/features/improvements/api', () => ({
  getImprovements: async () => ({
    items: [
      {
        id: 'imp-1',
        created_at: '2026-10-01T10:00:00.000Z',
        task_ref: 'acme/api#7',
        agent: 'retrospective',
        target: 'docs',
        repo: 'acme/api',
        title: 'Documentar los tests',
        body: 'cuerpo',
        reason: 'motivo',
        status: 'open',
      },
    ],
  }),
  openImprovement: vi.fn(),
  dismissImprovement: vi.fn(),
}))
vi.mock('@/features/inbox/stream', () => ({ connectRunnerStream: () => ({ close: vi.fn() }) }))
vi.mock('@/composables/useIsMobile', () => ({
  useIsSplit: () => ({ isSplit: ref(true) }),
  useIsMobile: () => ({ isMobile: ref(false) }),
}))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://runner.test', url: (p: string) => p }),
}))

import InboxView from '@/views/InboxView.vue'

describe('InboxView', () => {
  it('hay un solo .btn--primary en la pantalla: el de «Lo primero»', async () => {
    setActivePinia(createPinia())
    const w = mount(InboxView, { global: { plugins: [createPinia()] } })
    await flushPromises()
    expect(w.find('[data-test="improvements"]').exists()).toBe(true)
    const primaries = w.findAll('.btn--primary')
    expect(primaries).toHaveLength(1)
    expect(w.get('[data-test="first"]').find('.btn--primary').exists()).toBe(true)
    expect(w.findAll('h1').map((h) => h.text())).toEqual(['Bandeja'])
  })
})
