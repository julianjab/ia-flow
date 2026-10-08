import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { detail, execution, inbox, item, trace } from '@/features/inbox/test/fixtures'

const getInbox = vi.fn()
const getTasks = vi.fn()
const getTaskDetail = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  getInbox: (...a: unknown[]) => getInbox(...a),
  getTasks: (...a: unknown[]) => getTasks(...a),
  getTaskDetail: (...a: unknown[]) => getTaskDetail(...a),
  getBoardRest: vi.fn(),
  postTaskAction: vi.fn(),
  explainTask: vi.fn(),
}))
const close = vi.fn()
vi.mock('@/features/inbox/stream', () => ({ connectRunnerStream: () => ({ close }) }))
const split = ref(false)
vi.mock('@/composables/useIsMobile', () => ({
  useIsSplit: () => ({ isSplit: split }),
  useIsMobile: () => ({ isMobile: ref(false) }),
}))
vi.mock('@/composables/useServerTarget', () => ({
  serverTarget: () => ({ base: 'https://runner.test', url: (p: string) => p }),
}))

import InboxBoard from '@/features/inbox/InboxBoard.vue'
import { useAssistantStore } from '@/stores/assistant'
import { useTaskFocusStore } from '@/stores/taskFocus'

const merge = item({ ref: 'acme/api#1', group: 'need', kind: 'merge', title: 'Listo para mergear' })
const fail = item({
  ref: 'acme/api#2',
  group: 'fail',
  kind: 'crash',
  title: 'Se rompió',
  why: 'La corrida falló',
  actions: ['retry'],
  execution: execution({
    status: 'failed',
    failure: { by: 'runtime', message: '{"status":502,"message":"presupuesto agotado"}' },
  }),
})
const run = item({
  ref: 'acme/api#3',
  group: 'run',
  kind: 'agent',
  title: 'Corriendo ahora',
  actions: ['stop'],
  execution: execution({ status: 'running', agent_id: 'implementer' }),
})
const waiting = item({ ref: 'acme/api#4', group: 'queue', kind: 'agent', title: 'En cola' })

async function mountBoard() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(InboxBoard, { global: { plugins: [pinia] }, attachTo: document.body })
  await flushPromises()
  return { wrapper, pinia }
}

describe('InboxBoard', () => {
  beforeEach(() => {
    localStorage.clear()
    split.value = false
    getInbox.mockReset()
    // Un runner viejo: sin /api/tasks, la bandeja viene clasificada por grupo.
    getTasks.mockReset().mockResolvedValue(null)
    getTaskDetail
      .mockReset()
      .mockImplementation(async (ref: string) => detail(item({ ref, agent_said: 'Aprobado.' })))
    close.mockReset()
  })

  it('titular, «Lo primero» con la primera decisión y «Después» numerado; lo que corre no es una card', async () => {
    getInbox.mockResolvedValue(inbox([merge, fail, run, waiting]))
    const { wrapper } = await mountBoard()

    const headline = wrapper.get('[data-test="headline"]').text()
    expect(headline).toContain('2 decisiones te esperan')
    expect(headline).toContain('2 tareas')
    expect(headline).toContain('✕ 1 falló')

    const first = wrapper.get('[data-test="first"]')
    expect(first.text()).toContain('Lo primero · 1 de 2')
    expect(first.text()).toContain('Listo para mergear')
    expect(wrapper.findAll('.dr').map((r) => r.find('.dr__rank').text())).toEqual(['2'])
    expect(wrapper.get('.dr').text()).toContain('Se rompió')

    // Lo que corre o espera no sale como card: sólo en el pipeline.
    expect(wrapper.find('#card-acme\\/api\\#4').exists()).toBe(false)
    expect(wrapper.findAll('article').some((a) => a.text().includes('Corriendo ahora'))).toBe(false)
    const line = wrapper.get('[data-test="pipeline-line"]').text()
    expect(line).toContain('1 corriendo')
    expect(line).toContain('1 en cola')
    // Sin el bloque viejo de grupos.
    expect(wrapper.text()).not.toContain('Nada por acá')
    expect(wrapper.find('.sum__stat').exists()).toBe(false)
  })

  it('hay un solo botón primario en la pantalla: el de «Lo primero»', async () => {
    getInbox.mockResolvedValue(inbox([merge, fail]))
    const { wrapper } = await mountBoard()
    const primaries = wrapper.findAll('.btn--primary')
    expect(primaries).toHaveLength(1)
    expect(primaries[0]?.text()).toBe('Mergear…')
    expect(wrapper.get('.dr [data-action="retry"]').classes()).not.toContain('btn--primary')
  })

  it('con la leyenda abierta (y su editor) sigue habiendo un solo primario', async () => {
    getTasks.mockResolvedValue({
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
    })
    const { wrapper } = await mountBoard()
    const legend = wrapper.get('.lg details').element as HTMLDetailsElement
    legend.open = true
    await flushPromises()
    expect(wrapper.find('.lg [data-test="save"]').exists()).toBe(true)
    expect(wrapper.findAll('.btn--primary')).toHaveLength(1)
  })

  it('sin fallas, el titular lo dice; toda referencia es un link corto a GitHub', async () => {
    getInbox.mockResolvedValue(inbox([merge]))
    const { wrapper } = await mountBoard()
    expect(wrapper.get('[data-test="headline"]').text()).toContain('nada falló')
    const link = wrapper.get('[data-test="first"] a.ref')
    expect(link.text()).toBe('api#1 ↗')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toContain('noopener')
  })

  it('desde 1100 px el pipeline va al costado y no se repite bajo el titular', async () => {
    split.value = true
    getInbox.mockResolvedValue(inbox([merge, run]))
    const { wrapper } = await mountBoard()
    expect(wrapper.find('[data-test="pipeline-line"]').exists()).toBe(false)
    const aside = wrapper.get('aside')
    expect(aside.get('[data-test="cell-running"]').text()).toContain('1')
    expect(aside.text()).toContain('Corriendo ahora')
    expect(aside.text()).toContain('Cuenta tarjetas')
  })

  it('desde 1100 px «Dónde se traba cada épica» va al costado, entre el pipeline y la higiene', async () => {
    split.value = true
    const epic = { ref: 'acme/api#100', title: 'Filtros del listado', done: 3, total: 5 }
    getInbox.mockResolvedValue(inbox([{ ...merge, epic }, run]))
    const { wrapper } = await mountBoard()
    const section = wrapper.get('aside [data-test="epics"]')
    expect(section.get('h2').text()).toBe('Dónde se traba cada épica')
    expect(section.text()).toContain('3/5')
    expect(section.get('[data-test="epic-neck"]').text()).toBe('#1 espera tu merge')
    expect(
      wrapper.find('main [data-test="epics"], .board__main [data-test="epics"]').exists(),
    ).toBe(false)
  })

  it('bajo 1100 las épicas van plegadas con cuántas están trabadas en vos; sin épicas, nada', async () => {
    const epic = { ref: 'acme/api#100', title: 'Filtros del listado', done: 3, total: 5 }
    getInbox.mockResolvedValue(inbox([{ ...merge, epic }, fail]))
    const { wrapper } = await mountBoard()
    const folded = wrapper.get('.board__main [data-test="epics"]')
    expect(folded.find('details').attributes('open')).toBeUndefined()
    expect(folded.get('[data-test="epics-stuck"]').text()).toBe('1 trabada en vos')
    wrapper.unmount()

    getInbox.mockResolvedValue(inbox([merge, fail]))
    const bare = await mountBoard()
    expect(bare.wrapper.find('[data-test="epics"]').exists()).toBe(false)
  })

  it('abrir una fila muestra «Qué pasó» y el error crudo una sola vez, plegado', async () => {
    getInbox.mockResolvedValue(inbox([merge, fail]))
    const { wrapper } = await mountBoard()
    const toggle = wrapper.get('.dr [data-test="toggle"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()

    expect(toggle.attributes('aria-expanded')).toBe('true')
    const row = wrapper.get('.dr')
    expect(row.text()).toContain('Qué pasó')
    expect(row.text()).toContain('La corrida falló')
    expect(row.text()).toContain('→ Falló el runner, no el código')
    expect(row.text().split('presupuesto agotado')).toHaveLength(2)
    expect(row.get('details pre').text()).toContain('presupuesto agotado')
    // El botón sigue en la fila cerrada, arriba.
    expect(row.get('.dr__head [data-action="retry"]').exists()).toBe(true)
  })

  it('«Corridas» abre el detalle en grande; Escape lo cierra', async () => {
    getInbox.mockResolvedValue(inbox([merge]))
    getTaskDetail.mockResolvedValue(
      detail(merge, {
        executions: [execution({ id: 'ex1', status: 'running' })],
        trace: [trace({ name: 'fs_read app/models/ability.rb' })],
      }),
    )
    const { wrapper } = await mountBoard()
    await wrapper.get('[data-test="first"] [data-test="runs"]').trigger('click')
    await flushPromises()

    const panel = document.body.querySelector('[role="dialog"]')
    expect(panel?.getAttribute('aria-label')).toBe('Detalle de acme/api#1')
    expect(panel?.textContent).toContain('fs_read app/models/ability.rb')
    // La cabecera: tono por TIPO (glifo), sin borde de color por grupo, y el ref como link corto.
    expect(panel?.querySelector('[data-group]')).toBeNull()
    expect(panel?.querySelector('.dd__kind')?.textContent).toContain('✓')
    expect(panel?.querySelector('.dd__head a.ref')?.textContent).toBe('api#1 ↗')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    wrapper.unmount()
  })

  it('en el detalle grande el error crudo sale una vez y los bloqueantes son links cortos', async () => {
    const message = '{"status":502,"message":"presupuesto agotado"}'
    const broken = { ...fail, why: message, blocked_by: ['la-haus/subscriptions#1187'] }
    getInbox.mockResolvedValue(inbox([broken]))
    getTaskDetail.mockResolvedValue(
      detail(broken, {
        executions: [execution({ status: 'failed', failure: { by: 'runtime', message } })],
      }),
    )
    const { wrapper } = await mountBoard()
    await wrapper.get('[data-test="first"] [data-test="runs"]').trigger('click')
    await flushPromises()
    const panel = document.body.querySelector('[role="dialog"]') as HTMLElement
    expect(panel.textContent?.split(message)).toHaveLength(2)
    const blocker = panel.querySelector(
      'a[href="https://github.com/la-haus/subscriptions/issues/1187"]',
    )
    expect(blocker?.textContent).toBe('subs#1187 ↗')
    wrapper.unmount()
  })

  it('«◆ Abrir en el asistente» abre el asistente apuntado a esa tarea', async () => {
    getInbox.mockResolvedValue(inbox([merge]))
    const { wrapper } = await mountBoard()
    await wrapper.get('[data-test="first"] [data-test="ask"]').trigger('click')
    const assistant = useAssistantStore()
    expect(assistant.isOpen).toBe(true)
    expect(assistant.request).toEqual({ kind: 'task', ref: 'acme/api#1' })
  })

  it('una tarea pedida desde afuera que no es fila de la cola se abre en grande', async () => {
    getInbox.mockResolvedValue(inbox([merge, run]))
    const { wrapper, pinia } = await mountBoard()
    useTaskFocusStore(pinia).focus('acme/api#99')
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe(
      'Detalle de acme/api#99',
    )
    wrapper.unmount()
  })

  it('con más de un proyecto ofrece el filtro por proyecto y acota la cola', async () => {
    getInbox.mockResolvedValue(
      inbox(
        [merge, item({ ref: 'x/y#5', project_id: 'web', title: 'Otro proyecto' })],
        [
          { id: 'core', board: { owner: 'a', number: 1 } },
          { id: 'web', board: { owner: 'b', number: 2 } },
        ],
      ),
    )
    const { wrapper } = await mountBoard()
    const chips = wrapper.findAll('.tb__chips .filter-chip')
    expect(chips.map((c) => c.text())).toEqual(['Todos', 'core', 'web'])
    await chips[2]?.trigger('click')
    expect(wrapper.get('[data-test="first"]').text()).toContain('Otro proyecto')
    expect(wrapper.find('.dr').exists()).toBe(false)
  })

  it('sin decisiones lo dice; con error muestra el mensaje y una acción', async () => {
    getInbox.mockResolvedValue(inbox([run]))
    const empty = (await mountBoard()).wrapper
    expect(empty.text()).toContain('Todo en orden')
    expect(empty.find('[data-test="headline"]').exists()).toBe(false)

    getInbox.mockRejectedValue(new Error('runner caído'))
    const { wrapper } = await mountBoard()
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('✕ No se pudo cargar la bandeja: runner caído')
    expect(alert.text()).toContain('→ Reintentá; si persiste, revisá que el runner esté corriendo.')
    expect(alert.get('button').text()).toBe('Reintentar')
  })

  it('carga: mientras espera la primera respuesta, cada sección muestra su esqueleto', async () => {
    getInbox.mockReturnValue(new Promise(() => {}))
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(InboxBoard, { global: { plugins: [pinia] } })
    await flushPromises()
    const busy = wrapper.findAll('[aria-busy="true"]')
    expect(busy.map((b) => b.attributes('data-test'))).toEqual([
      'skeleton-pipeline-line',
      'skeleton-queue',
      'skeleton-feed',
    ])
    expect(wrapper.get('[data-test="skeleton-queue"] [role="status"]').text()).toBe(
      'cargando las decisiones…',
    )
    // El titular es parte de las decisiones: no se anuncia dos veces.
    expect(wrapper.get('[data-test="skeleton-headline"]').attributes('aria-hidden')).toBe('true')
    expect(wrapper.text()).not.toContain('cargando la bandeja')
  })

  it('al desmontar corta el stream', async () => {
    getInbox.mockResolvedValue(inbox([]))
    const { wrapper } = await mountBoard()
    wrapper.unmount()
    expect(close).toHaveBeenCalled()
  })

  it('arriba, los links al Project y a su board en GitHub', async () => {
    const url = 'https://github.com/orgs/acme/projects/1'
    getInbox.mockResolvedValue({
      ...inbox([merge]),
      projects: [
        { id: 'core', board: { owner: 'acme', number: 1 }, url, board_url: `${url}/views/3` },
      ],
    })
    const { wrapper } = await mountBoard()
    const links = wrapper.findAll('.tb__link')
    expect(links.map((l) => [l.text(), l.attributes('href')])).toEqual([
      ['Proyecto ↗', url],
      ['Board ↗', `${url}/views/3`],
    ])
    for (const l of links) expect(l.classes()).toContain('link')
  })

  it('al final, plegados, el board de GitHub y «Cómo se ordenan las decisiones»', async () => {
    getInbox.mockResolvedValue(inbox([]))
    const { wrapper } = await mountBoard()
    expect(wrapper.get('.br details').attributes('open')).toBeUndefined()
    expect(wrapper.get('.br summary').text()).toContain('Board de GitHub')
    expect(wrapper.get('.lg h2').text()).toBe('Cómo se ordenan las decisiones')
    expect(wrapper.get('.lg').text()).toContain('status Review + label reviewed')
  })
})
