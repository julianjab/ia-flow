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

import { useAssistantStore } from '@/stores/assistant'
import ImprovementsSection from '../ImprovementsSection.vue'

async function mountSection() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const wrapper = mount(ImprovementsSection, {
    global: { plugins: [pinia] },
    attachTo: document.body,
  })
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

  it('con pendientes muestra el conteo y una fila corta por propuesta; tocarla abre su detalle', async () => {
    getImprovements.mockResolvedValue({
      items: [proposal(), proposal({ id: 'imp-2', title: 'Otra' })],
    })
    const wrapper = await mountSection()
    expect(wrapper.text()).toContain('Mejoras propuestas')
    expect(wrapper.get('[data-test="count"]').text()).toBe('2')
    const rows = wrapper.findAll('[data-test="improvement-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('Docs del repo')
    // La card entera sólo vive en el detalle.
    expect(document.body.querySelector('[data-test="title"]')).toBeNull()
    await rows[0]?.trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-test="title"]')?.textContent).toBe(
      'Documentar el comando de tests',
    )
    ;(document.body.querySelector('[data-test="task"]') as HTMLElement).click()
    await flushPromises()
    expect(wrapper.emitted('open')?.[0]).toEqual(['acme/api#7'])
    wrapper.unmount()
  })

  it('«¿Por qué?» abre el asistente sobre la tarea de origen, con la mejora como contexto', async () => {
    getImprovements.mockResolvedValue({ items: [proposal()] })
    const wrapper = await mountSection()
    await wrapper.get('[data-test="improvement-row"]').trigger('click')
    await flushPromises()
    ;(document.body.querySelector('[data-test="why"]') as HTMLElement).click()
    await flushPromises()
    const assistant = useAssistantStore()
    expect(assistant.isOpen).toBe(true)
    expect(assistant.request).toEqual({ kind: 'task', ref: 'acme/api#7' })
    expect(assistant.message).toBe('¿Por qué propusiste esto?')
    expect(assistant.topic?.title).toBe('la mejora «Documentar el comando de tests»')
    expect(assistant.topic?.context).toContain('Pregunto por la mejora imp-1')
  })
})
