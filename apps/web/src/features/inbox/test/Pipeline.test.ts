import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { execution, item } from '@/features/inbox/test/fixtures'

const postTaskAction = vi.fn()
vi.mock('@/features/inbox/api', () => ({
  getInbox: vi.fn().mockResolvedValue({ generated_at: 'x', projects: [], items: [] }),
  getTasks: vi.fn().mockResolvedValue(null),
  getTaskDetail: vi.fn(),
  postTaskAction: (...a: unknown[]) => postTaskAction(...a),
}))
const mobile = ref(false)
vi.mock('@/composables/useIsMobile', () => ({
  useIsMobile: () => ({ isMobile: mobile }),
  useIsSplit: () => ({ isSplit: ref(true) }),
}))

import FeedList from '@/features/inbox/pipeline/FeedList.vue'
import PipelineCells from '@/features/inbox/pipeline/PipelineCells.vue'
import PipelineLine from '@/features/inbox/pipeline/PipelineLine.vue'
import { buildQueue } from '@/features/inbox/queue/build'
import { useGithubSessionStore } from '@/stores/githubSession'

const NOW = Date.parse('2026-01-01T10:12:00.000Z')
const running = item({
  ref: 'la-haus/subscriptions#1195',
  group: 'run',
  kind: 'agent',
  title: 'Cache de tarifas',
  actions: ['stop'],
  execution: execution({ agent_id: 'implementer' }),
})
const capacity = { running: 2, waiting: 0, paused: 0, max_concurrent: 3, free: 1 }
const feed = {
  title: 'Qué le das al pipeline',
  entries: [
    {
      ref: 'la-haus/subscriptions#1203',
      title: 'Auditoría de cambios de precio por unidad',
      url: 'https://github.com/x/1203',
      action: { id: 'start_refine', label: 'Refine' },
    },
  ],
}

function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  useGithubSessionStore().github = { token: 'gho_1', login: 'ada' }
  return pinia
}

describe('el pipeline', () => {
  beforeEach(() => {
    postTaskAction.mockReset().mockResolvedValue({ ok: true, message: 'listo' })
    mobile.value = false
  })

  it('al costado: tres celdas (corriendo · en cola · libres de max) y lo que corre al abrir', async () => {
    const pinia = setup()
    const q = buildQueue({ items: [running], capacity, now: NOW })
    const w = mount(PipelineCells, {
      props: { pipeline: q.pipeline, running: q.running },
      global: { plugins: [pinia] },
    })
    const cell = w.get('[data-test="cell-running"]')
    expect(cell.text()).toContain('2')
    expect(cell.attributes('aria-expanded')).toBe('true')
    expect(cell.attributes('aria-controls')).toBe('pipe-running')
    expect(w.find('#pipe-running').exists()).toBe(true)
    // Sin nada en cola, «en cola» es sólo número.
    expect(w.get('[data-test="cell-waiting"]').element.tagName).toBe('DIV')
    expect(w.get('[data-test="cell-waiting"]').attributes('aria-expanded')).toBeUndefined()
    // El chevron va en la línea del número, no pegado a la etiqueta (se partía a otra línea).
    const free = w.get('[data-test="cell-free"]')
    expect(free.get('.pc__top').text()).toBe('1▾')
    expect(free.text()).toContain('libre de 3')
    expect(free.text()).not.toContain('libre de 3 ▾')
    expect(w.get('[data-test="running"]').text()).toContain('subs#1195')
    expect(w.get('[data-test="running"]').text()).toContain('implementer')
    expect(w.text()).toContain('Cuenta ejecuciones, no tarjetas')

    await cell.trigger('click')
    expect(cell.attributes('aria-expanded')).toBe('false')
    expect(w.get('#pipe-running').attributes('style')).toContain('display: none')
  })

  it('«en cola» lista lo que espera y «libres» explica quién toma el lugar; de a una celda', async () => {
    const pinia = setup()
    const queued = item({ ref: 'acme/api#9', group: 'queue', kind: 'agent', title: 'Espera turno' })
    const q = buildQueue({ items: [running, queued], capacity, now: NOW })
    const w = mount(PipelineCells, {
      props: { pipeline: q.pipeline, running: q.running, queued: q.queued },
      global: { plugins: [pinia] },
    })
    const waiting = w.get('[data-test="cell-waiting"]')
    expect(waiting.element.tagName).toBe('BUTTON')
    await waiting.trigger('click')
    expect(waiting.attributes('aria-expanded')).toBe('true')
    expect(w.get('[data-test="cell-running"]').attributes('aria-expanded')).toBe('false')
    expect(w.get('#pipe-waiting').text()).toContain('Espera turno')

    const free = w.get('[data-test="cell-free"]')
    await free.trigger('click')
    expect(free.attributes('aria-expanded')).toBe('true')
    expect(waiting.attributes('aria-expanded')).toBe('false')
    expect(w.get('#pipe-free').text()).toContain('Lo toma lo primero que pase a Refine o a Build')
  })

  it('«Detener…» confirma en línea antes de mandar nada', async () => {
    const pinia = setup()
    const q = buildQueue({ items: [running], capacity, now: NOW })
    const w = mount(PipelineCells, {
      props: { pipeline: q.pipeline, running: q.running },
      global: { plugins: [pinia] },
    })
    await w.get('[data-action="stop"] button').trigger('click')
    expect(w.get('[data-test="inline-confirm"]').text()).toContain('Se detiene la ejecución')
    expect(postTaskAction).not.toHaveBeenCalled()
    await w.get('[data-test="confirm"]').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith(running.ref, { action: 'stop' }, 'gho_1')
  })

  it('con un runner viejo (sin capacity) cuenta las tarjetas y no inventa libres', () => {
    const pinia = setup()
    const q = buildQueue({ items: [running, item({ ref: 'a/b#9', group: 'queue' })], now: NOW })
    const w = mount(PipelineLine, {
      props: { pipeline: q.pipeline, running: q.running },
      global: { plugins: [pinia] },
    })
    const sum = w.get('summary').text()
    expect(w.get('summary .dz__chev').text()).toBe('▸')
    expect(sum).toContain('1 corriendo')
    expect(sum).toContain('1 en cola')
    expect(sum).not.toContain('libre')
    expect(w.text()).toContain('Cuenta tarjetas')
  })

  it('la línea arranca abierta si algo corre (Detener… a la vista) y plegada si no', () => {
    const pinia = setup()
    const busy = buildQueue({ items: [running], capacity, now: NOW })
    const open = mount(PipelineLine, {
      props: { pipeline: busy.pipeline, running: busy.running },
      global: { plugins: [pinia] },
    })
    expect(open.get('details').attributes('open')).toBeDefined()
    const idle = buildQueue({ items: [], capacity, now: NOW })
    const closed = mount(PipelineLine, {
      props: { pipeline: idle.pipeline, running: idle.running },
      global: { plugins: [pinia] },
    })
    expect(closed.get('details').attributes('open')).toBeUndefined()
  })
})

describe('Qué le das al pipeline', () => {
  beforeEach(() => postTaskAction.mockReset().mockResolvedValue({ ok: true, message: 'listo' }))

  it('una línea por tarea con su estado, link corto y acción; el encabezado dice los lugares libres', async () => {
    const pinia = setup()
    const q = buildQueue({ items: [], capacity, feed, now: NOW })
    const w = mount(FeedList, {
      props: { feed: q.feed as NonNullable<typeof q.feed> },
      global: { plugins: [pinia] },
    })
    const sum = w.get('summary').text()
    expect(sum).toContain('1 lugar libre')
    expect(sum).toContain('1 lista para correr')
    expect(w.get('details').attributes('open')).toBeDefined()
    const row = w.get('.fl__row')
    expect(row.text()).toContain('● lista')
    expect(row.get('a.ref').text()).toBe('subs#1203 ↗')
    await row.get('button').trigger('click')
    await flushPromises()
    expect(postTaskAction).toHaveBeenCalledWith(
      'la-haus/subscriptions#1203',
      { action: 'start_refine' },
      'gho_1',
    )
  })

  it('en el teléfono arranca plegado', () => {
    mobile.value = true
    const pinia = setup()
    const q = buildQueue({ items: [], feed, now: NOW })
    const w = mount(FeedList, {
      props: { feed: q.feed as NonNullable<typeof q.feed> },
      global: { plugins: [pinia] },
    })
    expect(w.get('details').attributes('open')).toBeUndefined()
  })

  it('sin listas lo dice en el encabezado; sin capacity no habla de lugares', () => {
    const pinia = setup()
    const q = buildQueue({ items: [], feed: { ...feed, entries: [] }, now: NOW })
    const w = mount(FeedList, {
      props: { feed: q.feed as NonNullable<typeof q.feed> },
      global: { plugins: [pinia] },
    })
    const sum = w.get('summary').text()
    expect(sum).toContain('nada listo para correr')
    expect(sum).not.toContain('lugar')
    expect(w.find('.fl__row').exists()).toBe(false)
  })
})

describe('el pipeline con los datos del :3011', () => {
  const dep = (n: number, blocker: number) =>
    item({
      ref: `la-haus/subscriptions#${n}`,
      url: `https://github.com/la-haus/subscriptions/issues/${n}`,
      title: `Espera a #${blocker}`,
      group: 'queue',
      kind: 'dep',
      blocked_by: [`la-haus/subscriptions#${blocker}`],
    })
  const idle = { running: 0, waiting: 0, paused: 0, max_concurrent: 5, free: 5 }
  const ready = (n: number) => ({
    ref: `la-haus/subscriptions#${n}`,
    title: `Lista ${n}`,
    url: `https://github.com/la-haus/subscriptions/issues/${n}`,
  })

  it('«en cola» dice 0 y no lista las que esperan a otra tarea: van en su propia línea', () => {
    const pinia = setup()
    const q = buildQueue({ items: [dep(1580, 1579), dep(1776, 1775)], capacity: idle, now: NOW })
    const w = mount(PipelineCells, {
      props: { pipeline: q.pipeline, running: q.running, queued: q.queued, blocked: q.blocked },
      global: { plugins: [pinia] },
    })
    const waiting = w.get('[data-test="cell-waiting"]')
    expect(waiting.text()).toContain('0')
    expect(waiting.element.tagName).toBe('DIV')
    const blocked = w.get('[data-test="blocked"]')
    expect(blocked.get('summary').text()).toContain('2 esperan a otra tarea')
    expect(blocked.get('details').attributes('open')).toBeUndefined()
    const rows = blocked.findAll('.bl__row')
    expect(rows[0]?.text()).toContain('○ espera')
    expect(rows[0]?.findAll('a.ref').map((a) => [a.text(), a.attributes('href')])).toEqual([
      ['subs#1580 ↗', 'https://github.com/la-haus/subscriptions/issues/1580'],
      ['subs#1579 ↗', 'https://github.com/la-haus/subscriptions/issues/1579'],
    ])
  })

  it('sin tarjetas que esperan a otra, la línea no se dibuja', () => {
    const pinia = setup()
    const q = buildQueue({ items: [running], capacity, now: NOW })
    const w = mount(PipelineLine, {
      props: { pipeline: q.pipeline, running: q.running, blocked: q.blocked },
      global: { plugins: [pinia] },
    })
    expect(w.find('[data-test="blocked"]').exists()).toBe(false)
  })

  it('«libres» abierto muestra las 3 primeras listas del feed y «y N más» lleva a la sección', async () => {
    const pinia = setup()
    const own = { title: 'Qué le das al pipeline', entries: [1, 2, 3, 4, 5].map(ready) }
    const q = buildQueue({ items: [], capacity: idle, feed: own, now: NOW })
    const w = mount(PipelineCells, {
      props: {
        pipeline: q.pipeline,
        running: q.running,
        feed: q.feed,
        feedAnchor: 'pipeline-feed',
      },
      global: { plugins: [pinia] },
    })
    await w.get('[data-test="cell-free"]').trigger('click')
    const free = w.get('[data-test="free-slots"]')
    expect(free.findAll('a.ref').map((a) => a.text())).toEqual(['subs#1 ↗', 'subs#2 ↗', 'subs#3 ↗'])
    const more = free.get('[data-test="free-more"]')
    expect(more.text()).toBe('y 2 más en Qué le das al pipeline')
    expect(more.attributes('href')).toBe('#pipeline-feed')
  })

  it('«libres» sin feed explica quién toma el lugar', async () => {
    const pinia = setup()
    const q = buildQueue({ items: [], capacity: idle, now: NOW })
    const w = mount(PipelineCells, {
      props: { pipeline: q.pipeline, running: q.running, feed: q.feed },
      global: { plugins: [pinia] },
    })
    await w.get('[data-test="cell-free"]').trigger('click')
    expect(w.get('[data-test="free-slots"]').text()).toContain('Lo toma lo primero que pase')
  })

  it('una fila sin agente ni antigüedad no deja un «·» colgando', () => {
    const pinia = setup()
    const bare = item({
      ref: 'la-haus/subscriptions#1580',
      group: 'queue',
      kind: 'turn',
      since: 'sin fecha',
      actions: [],
    })
    const q = buildQueue({ items: [bare], now: NOW })
    const w = mount(PipelineCells, {
      props: { pipeline: q.pipeline, running: q.running, queued: q.queued },
      global: { plugins: [pinia] },
    })
    const meta = w.get('#pipe-waiting .rl__meta').text().trim()
    expect(meta).toBe('subs#1580 ↗')
  })

  it('el feed del runner: las que esperan a otra dicen «○ espera» con el link al bloqueante', () => {
    const pinia = setup()
    const q = buildQueue({
      items: [],
      now: NOW,
      runner: {
        feed: {
          ready: [],
          waiting: [
            {
              ...ready(1580),
              project_id: 'p',
              labels: [],
              updated_at: 'x',
              blocked_by: ['la-haus/subscriptions#1579'],
            },
          ],
        },
      },
    })
    const w = mount(FeedList, {
      props: { feed: q.feed as NonNullable<typeof q.feed> },
      global: { plugins: [pinia] },
    })
    expect(w.get('summary').text()).toContain('nada listo para correr')
    expect(w.get('summary').text()).toContain('1 espera a otra')
    const row = w.get('.fl__row')
    expect(row.attributes('data-state')).toBe('waiting')
    expect(row.get('.fl__state').text()).toBe('○ espera subs#1579 ↗')
  })
})
