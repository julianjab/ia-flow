import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import AppShell from '../AppShell.vue'

const Blank = { template: '<p>pantalla</p>' }

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
  const w = mount({ template: '<router-view />' }, { global: { plugins: [router, pinia] } })
  await flushPromises()
  return { w, router }
}

describe('AppShell', () => {
  it('el menú lateral lleva a Bandeja, Config, Webhooks y Servidores', async () => {
    const { w } = await render()
    expect(w.findAll('.side__label').map((l) => l.text())).toEqual([
      'Bandeja',
      'Config',
      'Webhooks',
      'Servidores',
    ])
    expect(w.find('.side__link.router-link-exact-active .side__label').text()).toBe('Bandeja')
  })

  it('en un teléfono ☰ abre el menú, y elegir una pantalla lo guarda', async () => {
    const { w, router } = await render()
    const side = () => w.get('#side-nav').attributes('data-open')
    expect(side()).toBe('false')
    await w.get('.bar__menu').trigger('click')
    expect(side()).toBe('true')
    expect(w.get('.bar__menu').attributes('aria-expanded')).toBe('true')
    await router.push({ name: 'config' })
    await flushPromises()
    expect(side()).toBe('false')
  })

  it('tocar afuera o Escape también lo guardan', async () => {
    const { w } = await render()
    await w.get('.bar__menu').trigger('click')
    await w.get('.side-backdrop').trigger('click')
    expect(w.get('#side-nav').attributes('data-open')).toBe('false')
    await w.get('.bar__menu').trigger('click')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()
    expect(w.get('#side-nav').attributes('data-open')).toBe('false')
  })
})
