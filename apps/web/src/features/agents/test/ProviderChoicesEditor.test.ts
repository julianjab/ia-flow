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
  it('renders one row per candidate, in order', () => {
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
  })

  it('groups local and remote providers into separate optgroups', () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    const groups = wrapper.findAll('optgroup')
    expect(groups.map((g) => g.attributes('label'))).toEqual(['Locales', 'Remotos'])
    expect(groups[0].findAll('option')).toHaveLength(2)
    expect(groups[1].findAll('option')).toHaveLength(1)
  })

  it('adds a candidate not already in use and emits update:modelValue', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    await wrapper.get('.pce-add').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'anthropic-api' }, { providerId: 'tmux-claude' }])
  })

  it('removes a candidate when its remove button is clicked', async () => {
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
    // Move the middle row ("tmux-claude") down — it should swap with the last.
    const rows = wrapper.findAll('.pce-row')
    await rows[1].findAll('.pce-move-btn')[1].trigger('click')
    expect(wrapper.emitted('update:modelValue')?.at(-1)?.[0]).toEqual([
      { providerId: 'anthropic-api' },
      { providerId: 'remote:julianbuitrago-mac' },
      { providerId: 'tmux-claude' },
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
    await wrapper.get('.pce-cell-when input').setValue('repo tiene GPU')
    let emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'anthropic-api', whenText: 'repo tiene GPU' }])

    await wrapper.setProps({ modelValue: emitted })
    await wrapper.get('.pce-cell-when input').setValue('')
    emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    expect(emitted).toEqual([{ providerId: 'anthropic-api' }])
  })

  it('survives the parent echo when a candidate is added (echo-guard)', async () => {
    const wrapper = mount(ProviderChoicesEditor, {
      props: { modelValue: [{ providerId: 'anthropic-api' }], providers: PROVIDERS },
    })
    await wrapper.get('.pce-add').trigger('click')
    const emitted = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AgentProviderChoice[]
    await wrapper.setProps({ modelValue: emitted })
    expect(wrapper.findAll('.pce-row')).toHaveLength(2)
  })
})
