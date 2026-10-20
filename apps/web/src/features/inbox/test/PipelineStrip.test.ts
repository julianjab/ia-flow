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
import { recentOf } from '@/features/inbox/queue/recent'

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

describe('lo último que corrió', () => {
  const recent = recentOf(
    [
      {
        ref: 'acme/api#7',
        title: 'Filtro por precio',
        url: 'u',
        run: execution({ status: 'failed', closed_at: '2026-01-01T10:00:00.000Z' }),
      },
      {
        ref: 'acme/api#8',
        title: 'Paginación',
        url: 'u',
        run: execution({
          status: 'done',
          agent_id: 'reviewer',
          exit: 'changes_requested',
          closed_at: '2026-01-01T09:00:00.000Z',
        }),
      },
    ],
    NOW,
  )

  it('la franja dice cómo terminó la última y hace cuánto, aunque nada corra', () => {
    setActivePinia(createPinia())
    const q = buildQueue({
      items: [],
      capacity: { ...capacity, running: 0, waiting: 0, free: 3 },
      now: NOW,
    })
    const w = mount(PipelineStrip, {
      props: { pipeline: q.pipeline, running: [], recent, stream: 'live' },
    })
    expect(w.get('[data-test="strip-last"]').text()).toBe('✕ 12 min')
    expect(w.get('[data-test="strip-last"]').attributes('data-status')).toBe('failed')
  })

  it('el sheet las lista con quién, cómo salió y hace cuánto; el título abre el detalle', async () => {
    const w = render()
    await w.setProps({ recent })
    await w.get('[data-test="pipeline-strip"]').trigger('click')
    const rows = [...document.body.querySelectorAll('[data-test="recent"]')].map((r) =>
      r.textContent?.replace(/\s+/g, ' ').trim(),
    )
    expect(rows[0]).toContain('Filtro por precio')
    expect(rows[0]).toContain('falló')
    expect(rows[1]).toContain('reviewer')
    expect(rows[1]).toContain('→ changes_requested')
    expect(rows[1]).toContain('1 h')
    document.body.querySelector<HTMLButtonElement>('[data-test="recent-acme/api#8"]')?.click()
    const { useInboxStore } = await import('@/features/inbox/store')
    expect(useInboxStore().openRef).toBe('acme/api#8')
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
