import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execution, item } from '@/features/inbox/test/fixtures'

vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn(),
  getTasks: vi.fn(),
  getTaskDetail: vi.fn(),
  postTaskAction: vi.fn(),
}))

import InboxToolbar from '@/features/inbox/InboxToolbar.vue'
import PipelineStrip from '@/features/inbox/pipeline/PipelineStrip.vue'
import { buildQueue } from '@/features/inbox/queue/build'

const NOW = Date.parse('2026-01-01T10:12:00.000Z')
const running = item({
  ref: 'la-haus/subscriptions#1195',
  group: 'run',
  kind: 'agent',
  title: 'Cache de tarifas',
  actions: ['stop'],
  execution: execution({ agent_id: 'implementer' }),
})
const capacity = { running: 2, waiting: 1, paused: 0, max_concurrent: 3, free: 1 }

function render(stream: 'live' | 'reconnecting' | 'polling' = 'live') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const q = buildQueue({ items: [running], capacity, now: NOW })
  return mount(PipelineStrip, {
    props: { pipeline: q.pipeline, running: q.running, blocked: q.blocked, stream },
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('la franja del pipeline (teléfono)', () => {
  it('dice en una línea lo que corre, lo que espera y cuánto lugar queda', () => {
    const w = render()
    const text = w.get('[data-test="pipeline-strip"]').text()
    expect(text).toContain('2 corriendo')
    expect(text).toContain('1 en cola')
    expect(text).toContain('1 libre de 3')
    expect(w.find('.live-dot').exists()).toBe(true)
    w.unmount()
  })

  it('sin stream lo dice en la misma línea, en vez del punto en vivo', () => {
    const w = render('reconnecting')
    expect(w.find('.live-dot').exists()).toBe(false)
    expect(w.get('[data-test="pipeline-strip"]').text()).toContain('reconectando…')
    w.unmount()
  })

  it('tocarla abre un sheet con lo que corre y la capacidad dibujada', async () => {
    const w = render()
    expect(document.body.textContent).not.toContain('Cache de tarifas')
    await w.get('[data-test="pipeline-strip"]').trigger('click')
    expect(document.body.textContent).toContain('Cache de tarifas')
    const cells = [...document.body.querySelectorAll('.ps__cap i')].map((c) =>
      c.getAttribute('data-cell'),
    )
    expect(cells).toEqual(['run', 'run', 'free'])
    expect(document.body.textContent).toContain('Cuenta ejecuciones, no tarjetas.')
    w.unmount()
  })
})

describe('la toolbar compacta', () => {
  it('en un teléfono no repite el «en vivo» ni los links a GitHub', () => {
    const projects = [{ id: 'core', url: 'https://github.com/orgs/x/projects/1' }] as never
    const props = { projects, project: null, stream: 'live' as const, loading: false }
    const wide = mount(InboxToolbar, { props })
    expect(wide.text()).toContain('en vivo')
    expect(wide.text()).toContain('Proyecto ↗')
    const compact = mount(InboxToolbar, { props: { ...props, compact: true } })
    expect(compact.text()).not.toContain('en vivo')
    expect(compact.text()).not.toContain('Proyecto ↗')
    expect(compact.find('[data-test="refresh"]').attributes('aria-label')).toBe('Actualizar')
  })
})
