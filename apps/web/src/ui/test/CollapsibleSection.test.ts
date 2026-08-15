import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import CollapsibleSection from '../CollapsibleSection.vue'

// `v-show` colapsa el panel poniéndole `display: none` inline. Se afirma sobre
// eso y no sobre `isVisible()` de vue-test-utils: bajo happy-dom, `isVisible()`
// devuelve true aunque el estilo esté aplicado (necesita el nodo adjunto al
// documento), así que daría un falso verde/rojo según el entorno.
function panelHidden(wrapper: { find: (s: string) => { element: Element } }): boolean {
  return (wrapper.find('.cs-panel').element as HTMLElement).style.display === 'none'
}

describe('CollapsibleSection', () => {
  it('renders closed by default and opens on header click', async () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Permisos' },
      slots: { default: '<p>contenido</p>' },
    })

    const header = wrapper.get('.cs-header')
    expect(header.attributes('aria-expanded')).toBe('false')
    expect(panelHidden(wrapper)).toBe(true)

    await header.trigger('click')

    expect(header.attributes('aria-expanded')).toBe('true')
    expect(panelHidden(wrapper)).toBe(false)
  })

  it('respects defaultOpen', () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Activación', defaultOpen: true },
    })
    expect(wrapper.get('.cs-header').attributes('aria-expanded')).toBe('true')
  })

  it('shows the summary only while collapsed', async () => {
    const wrapper = mount(CollapsibleSection, {
      props: { title: 'Outcomes', summary: 'onFinish → Build · 2 labels' },
    })
    expect(wrapper.find('.cs-summary').text()).toBe('onFinish → Build · 2 labels')

    await wrapper.get('.cs-header').trigger('click')
    expect(wrapper.find('.cs-summary').exists()).toBe(false)
  })

  it('exposes aria-controls / aria-labelledby wiring the header to the panel', () => {
    const wrapper = mount(CollapsibleSection, { props: { title: 'Avanzado' } })
    const header = wrapper.get('.cs-header')
    const panel = wrapper.get('.cs-panel')
    expect(header.attributes('aria-controls')).toBe(panel.attributes('id'))
    expect(panel.attributes('aria-labelledby')).toBe(header.attributes('id'))
    expect(panel.attributes('role')).toBe('region')
  })

  it('forceOpen() exposed to the parent opens a collapsed section', async () => {
    const wrapper = mount(CollapsibleSection, { props: { title: 'Definición' } })
    expect(panelHidden(wrapper)).toBe(true)
    ;(wrapper.vm as unknown as { forceOpen: () => void }).forceOpen()
    await wrapper.vm.$nextTick()

    expect(panelHidden(wrapper)).toBe(false)
  })
})
