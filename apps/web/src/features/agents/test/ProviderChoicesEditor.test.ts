import type { AgentProviderChoice } from '@ia-flow/shared'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import ProviderChoicesEditor from '../ProviderChoicesEditor.vue'

const PROVIDERS = [
  { id: 'anthropic-api', name: 'Claude API (headless)' },
  { id: 'tmux-claude', name: 'Claude CLI (tmux + iTerm)' },
  { id: 'remote:julianbuitrago-mac', name: 'Claude API (headless) (julianbuitrago-mac)' },
]

describe('ProviderChoicesEditor', () => {
  it('shows a placeholder on the closed trigger when nothing is selected', () => {
    const wrapper = mount(ProviderChoicesEditor, { props: { modelValue: [], providers: PROVIDERS } })
    expect(wrapper.get('.pce-trigger-text').text()).toContain('Seleccioná')
    expect(wrapper.find('.pce-menu').exists()).toBe(false)
  })

  it('summarizes one candidate by name and 2+ with a "+N más" suffix', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    expect(wrapper.get('.pce-trigger-text').text()).toBe('Claude API (headless)')

    await wrapper.setProps({
      modelValue: [{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }],
    })
    expect(wrapper.get('.pce-trigger-text').text()).toBe('Claude API (headless) +1 más')
  })

  it('opens the menu on click and groups options into Locales/Remotos', async () => {
    const wrapper = mount(ProviderChoicesEditor, { props: { modelValue: [], providers: PROVIDERS } })
    await wrapper.get('.pce-trigger').trigger('click')
    expect(wrapper.find('.pce-menu').exists()).toBe(true)
    const groups = wrapper.findAll('.pce-group-lbl').map((el) => el.text())
    expect(groups).toEqual(['Locales', 'Remotos'])
    expect(wrapper.findAll('.pce-option')).toHaveLength(3)
  })

  it('opens the menu on focus as well', async () => {
    const wrapper = mount(ProviderChoicesEditor, { props: { modelValue: [], providers: PROVIDERS } })
    await wrapper.get('.pce-trigger').trigger('focus')
    expect(wrapper.find('.pce-menu').exists()).toBe(true)
  })

  it('checks reflect current selection and stay open across multiple toggles', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    await wrapper.get('.pce-trigger').trigger('click')
    const boxes = wrapper.findAll('.pce-option input')
    expect((boxes[0].element as HTMLInputElement).checked).toBe(true)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(false)

    await boxes[1].setValue(true)
    let emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }])
    await wrapper.setProps({ modelValue: emitted })

    // Menu stays open — a multi-select shouldn't close on every check.
    expect(wrapper.find('.pce-menu').exists()).toBe(true)

    await boxes[0].setValue(false)
    emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'tmux-claude' }])
  })

  it('closes the menu on a click outside', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [], providers: PROVIDERS },
      attachTo: document.body,
    })
    await wrapper.get('.pce-trigger').trigger('click')
    expect(wrapper.find('.pce-menu').exists()).toBe(true)
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('.pce-menu').exists()).toBe(false)
    wrapper.unmount()
  })

  it('closes the menu on Escape', async () => {
    const wrapper = mount(ProviderChoicesEditor, { props: { modelValue: [], providers: PROVIDERS } })
    await wrapper.get('.pce-trigger').trigger('click')
    await wrapper.get('.pce-trigger').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('.pce-menu').exists()).toBe(false)
  })

  it('removing a candidate via its ✕ button emits the rest', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: {
        modelValue: [{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }],
        providers: PROVIDERS,
      },
    })
    await wrapper.findAll('.pce-remove')[0].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { providerId: 'tmux-claude' },
    ])
  })

  it('hides reorder controls (drag handle, position, move buttons) with a single candidate', () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    expect(wrapper.find('.pce-drag').exists()).toBe(false)
    expect(wrapper.find('.pce-move').exists()).toBe(false)
    expect(wrapper.get('.pce-row').attributes('draggable')).toBe('false')
  })

  it('reorders candidates with the move up/down buttons once there are 2+', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: {
        modelValue: [
          { providerId: 'anthropic-api' },
          { providerId: 'tmux-claude' },
          { providerId: 'remote:julianbuitrago-mac' },
        ],
        providers: PROVIDERS,
      },
    })
    const rows = wrapper.findAll('.pce-row')
    await rows[1].findAll('.pce-move-btn')[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { providerId: 'anthropic-api' },
      { providerId: 'remote:julianbuitrago-mac' },
      { providerId: 'tmux-claude' },
    ])
  })

  it('reorders candidates via drag and drop', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: {
        modelValue: [
          { providerId: 'anthropic-api' },
          { providerId: 'tmux-claude' },
          { providerId: 'remote:julianbuitrago-mac' },
        ],
        providers: PROVIDERS,
      },
    })
    const rows = wrapper.findAll('.pce-row')
    await rows[0].trigger('dragstart')
    await rows[2].trigger('drop')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { providerId: 'tmux-claude' },
      { providerId: 'remote:julianbuitrago-mac' },
      { providerId: 'anthropic-api' },
    ])
  })

  it('sets whenText on a candidate and clears it back to undefined when emptied', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    await wrapper.get('.pce-when').setValue('repo tiene GPU')
    let emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'anthropic-api', whenText: 'repo tiene GPU' }])

    await wrapper.setProps({ modelValue: emitted })
    await wrapper.get('.pce-when').setValue('')
    emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'anthropic-api' }])
  })

  it('survives the parent echo when a candidate is added (echo-guard)', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    await wrapper.get('.pce-trigger').trigger('click')
    await wrapper.findAll('.pce-option input')[1].setValue(true)
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    await wrapper.setProps({ modelValue: emitted })
    expect(wrapper.findAll('.pce-row')).toHaveLength(2)
  })
})
