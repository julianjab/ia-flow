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
  it('renders one selected row per candidate, in order, all checked', () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: {
        modelValue: [{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }],
        providers: PROVIDERS,
      },
    })
    const rows = wrapper.findAll('.pce-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].get('.pce-pos').text()).toBe('1')
    expect(rows[1].get('.pce-pos').text()).toBe('2')
    for (const row of rows) {
      expect((row.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(true)
    }
  })

  it('groups the "available to add" providers into Locales/Remotos', () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [], providers: PROVIDERS },
    })
    const groupLabels = wrapper.findAll('.pce-group-lbl').map((el) => el.text())
    expect(groupLabels).toEqual(['Locales', 'Remotos'])
    expect(wrapper.findAll('.pce-available .pce-check-avail')).toHaveLength(3)
  })

  it('checking an available provider adds it as a selected candidate', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    const avail = wrapper.findAll('.pce-check-avail')
    await avail[0].get('input').setValue(true)
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }])
  })

  it('unchecking a selected row removes it', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: {
        modelValue: [{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }],
        providers: PROVIDERS,
      },
    })
    await wrapper.findAll('.pce-row')[0].get('input[type=checkbox]').setValue(false)
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { providerId: 'tmux-claude' },
    ])
  })

  it('reorders candidates with the move up/down buttons', async () => {
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

  it('disables move-up on the first row and move-down on the last', () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: {
        modelValue: [{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }],
        providers: PROVIDERS,
      },
    })
    const rows = wrapper.findAll('.pce-row')
    expect(rows[0].findAll('.pce-move-btn')[0].attributes('disabled')).toBeDefined()
    expect(rows[1].findAll('.pce-move-btn')[1].attributes('disabled')).toBeDefined()
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
    await wrapper.findAll('.pce-check-avail')[0].get('input').setValue(true)
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    await wrapper.setProps({ modelValue: emitted })
    expect(wrapper.findAll('.pce-row')).toHaveLength(2)
  })

  it('shows an empty state when nothing is selected yet', () => {
    const wrapper = mount(ProviderChoicesEditor, { props: { modelValue: [], providers: PROVIDERS } })
    expect(wrapper.findAll('.pce-row')).toHaveLength(0)
    expect(wrapper.get('.pce-selected .pce-empty').text()).toContain('Ninguno')
  })
})
