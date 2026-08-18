import CollapsibleSection from '@/ui/CollapsibleSection.vue'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'

describe('debug', () => {
  it('dump', () => {
    const w = mount(CollapsibleSection, { props: { title: 'X' }, slots: { default: '<p>hi</p>' } })
    console.log('HTML:', w.html())
    const panel = w.find('.cs-panel')
    console.log('style.display:', JSON.stringify((panel.element as HTMLElement).style.display))
    console.log('isVisible:', panel.isVisible())
    expect(true).toBe(true)
  })
})
