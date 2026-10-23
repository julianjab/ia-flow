import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { proposal } from './fixtures'

const getImprovements = vi.fn()
const dismissImprovement = vi.fn()
vi.mock('../api', () => ({
  getImprovements: (...a: unknown[]) => getImprovements(...a),
  openImprovement: vi.fn(),
  dismissImprovement: (...a: unknown[]) => dismissImprovement(...a),
}))

import { useAssistantStore } from '@/stores/assistant'
import { useGithubSessionStore } from '@/stores/githubSession'
import ImprovementDetail from '../ImprovementDetail.vue'
import ImprovementsSection from '../ImprovementsSection.vue'

const Blank = { template: '<p />' }

function router() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/mejoras', name: 'improvements', component: Blank },
      { path: '/mejoras/:id', name: 'improvement', component: Blank },
    ],
  })
}

async function mountSection() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const r = router()
  const wrapper = mount(ImprovementsSection, { global: { plugins: [pinia, r] } })
  await flushPromises()
  return { wrapper, r }
}

async function mountDetail(id = 'imp-1') {
  const pinia = createPinia()
  setActivePinia(pinia)
  const r = router()
  await r.push(`/mejoras/${id}`)
  const wrapper = mount(ImprovementDetail, { props: { id }, global: { plugins: [pinia, r] } })
  await flushPromises()
  return { wrapper, r }
}

describe('ImprovementsSection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('sin pendientes no se dibuja', async () => {
    getImprovements.mockResolvedValue({ items: [] })
    expect((await mountSection()).wrapper.find('[data-test="improvements"]').exists()).toBe(false)
  })

  it('un runner viejo (null) tampoco dibuja nada', async () => {
    getImprovements.mockResolvedValue(null)
    expect((await mountSection()).wrapper.find('[data-test="improvements"]').exists()).toBe(false)
  })

  it('con pendientes muestra el conteo y una fila corta por propuesta que lleva a su pantalla', async () => {
    getImprovements.mockResolvedValue({
      items: [proposal(), proposal({ id: 'imp-2', title: 'Otra' })],
    })
    const { wrapper } = await mountSection()
    expect(wrapper.text()).toContain('Mejoras propuestas')
    expect(wrapper.get('[data-test="count"]').text()).toBe('2')
    const rows = wrapper.findAll('[data-test="improvement-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.text()).toContain('Docs del repo')
    expect(rows[0]?.attributes('href')).toBe('/mejoras/imp-1')
    // La card entera sólo vive en la pantalla de la mejora.
    expect(wrapper.find('[data-test="title"]').exists()).toBe(false)
  })
})

describe('ImprovementDetail', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lleva la ruta de vuelta y la card; la tarea de origen se reemite', async () => {
    getImprovements.mockResolvedValue({ items: [proposal()] })
    const { wrapper } = await mountDetail()
    expect(wrapper.get('[data-test="improvement-back"]').attributes('href')).toBe('/mejoras')
    expect(wrapper.get('[data-test="title"]').text()).toBe('Documentar el comando de tests')
    await wrapper.get('[data-test="task"]').trigger('click')
    expect(wrapper.emitted('open')?.[0]).toEqual(['acme/api#7'])
  })

  it('«¿Por qué?» abre el asistente sobre la tarea de origen, con la mejora como contexto', async () => {
    getImprovements.mockResolvedValue({ items: [proposal()] })
    const { wrapper } = await mountDetail()
    await wrapper.get('[data-test="why"]').trigger('click')
    const assistant = useAssistantStore()
    expect(assistant.isOpen).toBe(true)
    expect(assistant.request).toEqual({ kind: 'task', ref: 'acme/api#7' })
    expect(assistant.message).toBe('¿Por qué propusiste esto?')
    expect(assistant.topic?.title).toBe('la mejora «Documentar el comando de tests»')
    expect(assistant.topic?.context).toContain('Pregunto por la mejora imp-1')
  })

  it('descartarla vuelve a la lista', async () => {
    getImprovements.mockResolvedValue({ items: [proposal()] })
    dismissImprovement.mockResolvedValue({ ok: true, message: 'descartada' })
    const { wrapper, r } = await mountDetail()
    useGithubSessionStore().github = { token: 'gho_1', login: 'ada' }
    await wrapper.get('[data-test="dismiss"]').trigger('click')
    await flushPromises()
    expect(r.currentRoute.value.name).toBe('improvements')
  })

  it('una que ya no está pendiente lo dice', async () => {
    getImprovements.mockResolvedValue({ items: [] })
    const { wrapper } = await mountDetail('imp-9')
    expect(wrapper.text()).toContain('Esta mejora ya no está pendiente')
  })
})
