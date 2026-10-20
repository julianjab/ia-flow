import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAssistantStore } from '@/stores/assistant'
import AppShell from '../AppShell.vue'

const Blank = { template: '<p>pantalla</p>' }

/**
 * El ancho de la ventana. `useIsMobile` lee `matchMedia` (que jsdom no trae) y
 * comparte UN `MediaQueryList` por query entre tests: el stub se arma una vez y
 * `matches` lee este flag, que `useIsMobile` re-sincroniza al volver a montar.
 */
let narrow = false
function phone() {
  narrow = true
}
beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return narrow && query.includes('max-width')
    },
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})
let mounted: { unmount: () => void } | null = null

async function render() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: '/',
        component: AppShell,
        children: [
          { path: '', name: 'inbox', component: Blank },
          { path: 'config', name: 'config', component: Blank },
          { path: 'webhooks', name: 'webhooks', component: Blank },
        ],
      },
      { path: '/servers', component: Blank },
    ],
  })
  await router.push('/')
  await router.isReady()
  const pinia = createPinia()
  setActivePinia(pinia)
  const w = mount(
    { template: '<router-view />' },
    { global: { plugins: [router, pinia] }, attachTo: document.body },
  )
  mounted = w
  await flushPromises()
  return { w, router }
}

afterEach(() => {
  mounted?.unmount()
  mounted = null
  narrow = false
  document.body.innerHTML = ''
})

describe('AppShell', () => {
  it('en desktop, el menú lateral lleva a Bandeja, Config, Webhooks y Runners', async () => {
    const { w } = await render()
    expect(w.findAll('.side__label').map((l) => l.text())).toEqual([
      'Bandeja',
      'Config',
      'Webhooks',
      'Runners',
    ])
    expect(w.find('.side__link.router-link-exact-active .side__label').text()).toBe('Bandeja')
    expect(w.find('[data-test="tab-inbox"]').exists()).toBe(false)
  })

  it('el chip del runner lleva a /servers', async () => {
    const { w, router } = await render()
    await w.get('.bar__server').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/servers')
  })

  it('en un teléfono no hay menú lateral: hay tab bar, y la Bandeja es la pestaña actual', async () => {
    phone()
    const { w } = await render()
    expect(w.find('.side').exists()).toBe(false)
    expect(w.findAll('.tb__label').map((l) => l.text())).toEqual([
      'Bandeja',
      'Asistente',
      'Webhooks',
      'Config',
    ])
    expect(w.get('[data-test="tab-inbox"]').classes()).toContain('router-link-exact-active')
  })

  it('sin decisiones la pestaña Bandeja no dibuja un contador en cero', async () => {
    phone()
    const { w } = await render()
    expect(w.find('[data-test="tab-inbox"] .tb__badge').exists()).toBe(false)
  })

  it('la pestaña Asistente abre el asistente y marca lo no leído', async () => {
    phone()
    const { w } = await render()
    const ui = useAssistantStore()
    ui.unread = true
    await flushPromises()
    expect(w.find('[data-test="tab-assistant"] .tb__dot').exists()).toBe(true)
    await w.get('[data-test="tab-assistant"]').trigger('click')
    expect(ui.isOpen).toBe(true)
    expect(ui.unread).toBe(false)
  })

  it('las pestañas de ruta navegan', async () => {
    phone()
    const { w, router } = await render()
    await w.get('[data-test="tab-config"]').trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('config')
  })
})
