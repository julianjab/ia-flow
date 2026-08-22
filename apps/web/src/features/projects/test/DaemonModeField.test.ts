import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DaemonModeField from '../DaemonModeField.vue'
import { resetProjectsMetaCache } from '../meta'

vi.mock('@/features/projects/api', () => ({
  fetchProjectsMeta: vi.fn(async () => ({
    sourceKinds: ['github', 'local', 'github-issues'],
    daemonModes: ['webhook', 'polling'],
    daemonModeFallback: 'polling',
  })),
}))

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('DaemonModeField', () => {
  beforeEach(() => resetProjectsMetaCache())

  it('offers inherit + every mode the server reports', async () => {
    const wrapper = mount(DaemonModeField, { props: { modelValue: null } })
    await flush()
    const options = wrapper.findAll('option').map((o) => o.attributes('value'))
    expect(options).toEqual(['', 'webhook', 'polling'])
  })

  it('labels the inherit option with the env fallback the server resolved', async () => {
    const wrapper = mount(DaemonModeField, { props: { modelValue: null } })
    await flush()
    expect(wrapper.findAll('option')[0].text()).toBe('Heredar (polling)')
    // Sin valor propio, el efectivo es el fallback — no el default compilado.
    expect(wrapper.text()).toContain('Efectivo: polling')
  })

  it('emits null when the user picks inherit, so the PATCH clears the setting', async () => {
    const wrapper = mount(DaemonModeField, { props: { modelValue: 'webhook' } })
    await wrapper.get('select').setValue('')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([null])
  })

  it('emits the picked mode as a plain string', async () => {
    const wrapper = mount(DaemonModeField, { props: { modelValue: null } })
    await flush()
    await wrapper.get('select').setValue('polling')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['polling'])
  })

  it('shows the explicit value as effective, ignoring the fallback', async () => {
    const wrapper = mount(DaemonModeField, { props: { modelValue: 'webhook' } })
    await flush()
    expect(wrapper.text()).toContain('Efectivo: webhook')
  })
})
