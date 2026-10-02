import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detail, execution, inbox, item, trace } from './fixtures'

const getInbox = vi.fn()
const getTaskDetail = vi.fn()

vi.mock('@/features/inbox/api', () => ({
  getInbox: (...a: unknown[]) => getInbox(...a),
  // Un runner viejo: sin /api/tasks, la bandeja viene clasificada.
  getTasks: () => Promise.resolve(null),
  getTaskDetail: (...a: unknown[]) => getTaskDetail(...a),
  postTaskAction: vi.fn(),
  explainTask: vi.fn(),
}))
const close = vi.fn()
vi.mock('@/features/inbox/stream', () => ({ connectRunnerStream: () => ({ close }) }))

import { useAssistantStore } from '@/stores/assistant'
import InboxBoard from '../InboxBoard.vue'

const need = item({ ref: 'acme/api#1', group: 'need', kind: 'merge', title: 'Listo para mergear' })
const fail = item({
  ref: 'acme/api#2',
  group: 'fail',
  kind: 'crash',
  title: 'Se rompió',
  actions: ['retry'],
  execution: execution({
    status: 'failed',
    failure: { by: 'runtime', message: 'presupuesto agotado' },
  }),
})
const run = item({
  ref: 'acme/api#3',
  group: 'run',
  kind: 'agent',
  title: 'Corriendo ahora',
  actions: ['stop'],
})

async function mountBoard() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(InboxBoard, { global: { plugins: [pinia] } })
  await flushPromises()
  return { wrapper, pinia }
}

describe('InboxBoard', () => {
  beforeEach(() => {
    localStorage.clear()
    getInbox.mockReset()
    getTaskDetail
      .mockReset()
      .mockImplementation(async (ref: string) => detail(item({ ref, agent_said: 'Aprobado.' })))
    close.mockReset()
  })

  it('muestra los cuatro contadores, las secciones en orden de urgencia y nada de contadores en cero', async () => {
    getInbox.mockResolvedValue(inbox([need, fail, run]))
    const { wrapper } = await mountBoard()

    const stats = wrapper.findAll('.sum__stat')
    expect(stats.map((s) => s.attributes('data-group'))).toEqual(['need', 'fail', 'run', 'queue'])
    // R10: la cola está vacía → sin número, y no se puede filtrar.
    expect(stats[3]?.find('.sum__n').exists()).toBe(false)
    expect(stats[3]?.attributes('disabled')).toBeDefined()
    expect(stats[0]?.find('.sum__n').text()).toBe('1')

    expect(wrapper.findAll('section.sec').map((s) => s.attributes('data-group'))).toEqual([
      'need',
      'fail',
      'run',
      'queue',
    ])
    expect(wrapper.text()).toContain('Listo para mergear')
    expect(wrapper.text()).toContain('Nada por acá.')
  })

  it('un contador filtra a su grupo y volver a tocarlo suelta el filtro', async () => {
    getInbox.mockResolvedValue(inbox([need, fail, run]))
    const { wrapper } = await mountBoard()

    await wrapper.find('.sum__stat[data-group="fail"]').trigger('click')
    expect(wrapper.findAll('section.sec')).toHaveLength(1)
    expect(wrapper.find('.sum__stat[data-group="fail"]').attributes('aria-pressed')).toBe('true')

    await wrapper.find('.sum__stat[data-group="fail"]').trigger('click')
    expect(wrapper.findAll('section.sec')).toHaveLength(4)
  })

  it('con más de un proyecto ofrece el filtro por proyecto; con uno, no', async () => {
    getInbox.mockResolvedValue(inbox([need], [{ id: 'core', board: { owner: 'a', number: 1 } }]))
    expect((await mountBoard()).wrapper.find('.tb__chips').exists()).toBe(false)

    getInbox.mockResolvedValue(
      inbox(
        [need, item({ ref: 'x/y#5', project_id: 'web', title: 'Otro proyecto' })],
        [
          { id: 'core', board: { owner: 'a', number: 1 } },
          { id: 'web', board: { owner: 'b', number: 2 } },
        ],
      ),
    )
    const { wrapper } = await mountBoard()
    const chips = wrapper.findAll('.tb__chip')
    expect(chips.map((c) => c.text())).toEqual(['Todos', 'core', 'web'])
    await chips[2]?.trigger('click')
    const titles = wrapper.findAll('.card__title').map((t) => t.text())
    expect(titles).toEqual(['Otro proyecto'])
  })

  it('abrir una tarjeta muestra lo que dijo el agente y sus acciones; la falla se lee en la card', async () => {
    getInbox.mockResolvedValue(inbox([fail]))
    getTaskDetail.mockResolvedValue(
      detail(fail, { item: { ...fail, agent_said: 'No pude terminar.' } as typeof fail }),
    )
    const { wrapper } = await mountBoard()

    await wrapper.find('.card__row').trigger('click')
    await flushPromises()

    expect(wrapper.find('.card__row').attributes('aria-expanded')).toBe('true')
    expect(wrapper.text()).toContain('No pude terminar.')
    expect(wrapper.text()).toContain('presupuesto agotado')
    expect(wrapper.find('[data-action="retry"]').exists()).toBe(true)
  })

  it('en la tarjeta el detalle es compacto; «Ver detalle completo» lo abre en grande con la traza', async () => {
    getInbox.mockResolvedValue(inbox([run]))
    getTaskDetail.mockResolvedValue(
      detail(run, { trace: [trace({ name: 'fs_read app/models/ability.rb' })] }),
    )
    const { wrapper } = await mountBoard()
    await wrapper.find('.card__row').trigger('click')
    await flushPromises()

    // En la columna angosta no va la traza: se ofrece verla en grande.
    expect(wrapper.find('.card .td__log').exists()).toBe(false)
    await wrapper.find('[data-test="expand"]').trigger('click')
    await flushPromises()

    const panel = document.body.querySelector('[role="dialog"]')
    expect(panel?.getAttribute('aria-label')).toBe('Detalle de acme/api#3')
    expect(panel?.textContent).toContain('fs_read app/models/ability.rb')
    expect(document.body.style.overflow).toBe('hidden')

    // Escape lo cierra y la tarjeta sigue abierta.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(wrapper.find('.card__row').attributes('aria-expanded')).toBe('true')
    expect(document.body.style.overflow).toBe('')
    wrapper.unmount()
  })

  it('«Preguntarle al asistente» abre el asistente apuntado a esa tarea', async () => {
    getInbox.mockResolvedValue(inbox([need]))
    const { wrapper } = await mountBoard()
    await wrapper.find('.card__row').trigger('click')
    await flushPromises()

    await wrapper.find('.td__ask').trigger('click')
    const assistant = useAssistantStore()
    expect(assistant.isOpen).toBe(true)
    expect(assistant.request).toEqual({ kind: 'task', ref: 'acme/api#1' })
  })

  it('sin pendientes lo dice; con error muestra el mensaje y una acción', async () => {
    getInbox.mockResolvedValue(inbox([]))
    expect((await mountBoard()).wrapper.text()).toContain('Todo en orden')

    getInbox.mockRejectedValue(new Error('runner caído'))
    const { wrapper } = await mountBoard()
    expect(wrapper.find('.board__err').text()).toContain('✕ runner caído')
    expect(wrapper.find('.board__err button').text()).toBe('Reintentar')
  })

  it('carga: mientras espera la primera respuesta lo dice', async () => {
    getInbox.mockReturnValue(new Promise(() => {}))
    const pinia = createPinia()
    setActivePinia(pinia)
    const wrapper = mount(InboxBoard, { global: { plugins: [pinia] } })
    await flushPromises()
    expect(wrapper.text()).toContain('cargando la bandeja')
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
      ...inbox([need]),
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
  })

  it('trae la leyenda «Cómo se decide cada grupo»', async () => {
    getInbox.mockResolvedValue(inbox([]))
    const { wrapper } = await mountBoard()
    expect(wrapper.find('.lg__sum').text()).toBe('Cómo se decide cada grupo')
    expect(wrapper.find('.lg').text()).toContain('status Review + label reviewed')
  })
})
