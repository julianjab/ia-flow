import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import ListBoardToggle from '@/components/ListBoardToggle.vue'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

describe('ListBoardToggle', () => {
  it('marca la vista abierta en video inverso', () => {
    const wrapper = mount(ListBoardToggle, { props: { projectId: 'p1', view: 'lista' } })
    const [lista, board] = wrapper.findAll('.lbt__opt')
    expect(lista.classes()).toContain('is-active')
    expect(board.classes()).not.toContain('is-active')
  })

  // La ruta /board sigue siendo válida: el toggle navega a ella, no la
  // reemplaza por un estado local.
  it('navega a la otra vista', async () => {
    const wrapper = mount(ListBoardToggle, { props: { projectId: 'p1', view: 'lista' } })
    await wrapper.findAll('.lbt__opt')[1].trigger('click')
    expect(push).toHaveBeenCalledWith('/projects/p1/board')
  })

  it('tocar la vista abierta no navega', async () => {
    push.mockClear()
    const wrapper = mount(ListBoardToggle, { props: { projectId: 'p1', view: 'board' } })
    await wrapper.findAll('.lbt__opt')[1].trigger('click')
    expect(push).not.toHaveBeenCalled()
  })

  // Un pipeline label/when-driven devuelve cero statuses y su board queda
  // vacío. En mobile este toggle es el único camino: ofrecerlo mandaría a una
  // pantalla vacía sin nada que explique por qué.
  it('sin statuses no ofrece el board', () => {
    const wrapper = mount(ListBoardToggle, {
      props: { projectId: 'p1', view: 'lista', boardAvailable: false },
    })
    expect(wrapper.find('.lbt').exists()).toBe(false)
  })

  it('sin proyecto no se dibuja', () => {
    const wrapper = mount(ListBoardToggle, { props: { projectId: null, view: 'lista' } })
    expect(wrapper.find('.lbt').exists()).toBe(false)
  })
})
