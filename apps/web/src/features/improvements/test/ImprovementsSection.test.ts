import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { proposal } from './fixtures'

const getImprovements = vi.fn()
vi.mock('../api', () => ({
  getImprovements: (...a: unknown[]) => getImprovements(...a),
  openImprovement: vi.fn(),
  dismissImprovement: vi.fn(),
}))

import ImprovementsSection from '../ImprovementsSection.vue'

async function mountSection() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(ImprovementsSection, { global: { plugins: [pinia] } })
  await flushPromises()
  return wrapper
}

describe('ImprovementsSection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sin pendientes no se dibuja', async () => {
    getImprovements.mockResolvedValue({ items: [] })
    expect((await mountSection()).find('[data-test="improvements"]').exists()).toBe(false)
  })

  it('un runner viejo (null) tampoco dibuja nada', async () => {
    getImprovements.mockResolvedValue(null)
    expect((await mountSection()).find('[data-test="improvements"]').exists()).toBe(false)
  })

  it('con pendientes muestra el conteo y una card por propuesta; la tarea se reemite', async () => {
    getImprovements.mockResolvedValue({
      items: [proposal(), proposal({ id: 'imp-2', title: 'Otra' })],
    })
    const wrapper = await mountSection()
    expect(wrapper.text()).toContain('Mejoras propuestas')
    expect(wrapper.get('[data-test="count"]').text()).toBe('2')
    expect(wrapper.findAll('[data-test="title"]')).toHaveLength(2)
    await wrapper.findAll('[data-test="task"]')[0]?.trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['acme/api#7'])
  })
})
