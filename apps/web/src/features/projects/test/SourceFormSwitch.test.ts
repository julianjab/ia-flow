import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetProjectsMetaCache } from '../meta'
import SourceFormSwitch from '../sources/SourceFormSwitch.vue'

const fetchProjectsMeta = vi.fn(async () => ({
  sourceKinds: ['github', 'local', 'github-issues'],
  daemonModes: ['webhook', 'polling'],
  daemonModeFallback: 'webhook',
}))

vi.mock('@/features/projects/api', () => ({
  fetchProjectsMeta: (...args: unknown[]) => fetchProjectsMeta(...(args as [])),
}))

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('SourceFormSwitch', () => {
  beforeEach(() => {
    resetProjectsMetaCache()
    fetchProjectsMeta.mockClear()
  })

  it('offers every kind the server has registered, github-issues included', async () => {
    const wrapper = mount(SourceFormSwitch, {
      props: { modelValue: { kind: 'local', config: {} } },
    })
    await flush()
    const kinds = wrapper.findAll('.sfs-select option').map((o) => o.attributes('value'))
    expect(kinds).toEqual(['github', 'local', 'github-issues'])
  })

  it('falls back to the compiled list when the meta call fails', async () => {
    fetchProjectsMeta.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mount(SourceFormSwitch, {
      props: { modelValue: { kind: 'local', config: {} } },
    })
    await flush()
    const kinds = wrapper.findAll('.sfs-select option').map((o) => o.attributes('value'))
    expect(kinds).toContain('github-issues')
  })

  it('renders the dedicated github-issues form instead of the JSON fallback', async () => {
    const wrapper = mount(SourceFormSwitch, {
      props: { modelValue: { kind: 'github-issues', config: { owner: 'julianjab' } } },
    })
    await flush()
    expect(wrapper.find('.gisf').exists()).toBe(true)
    expect(wrapper.find('.jsf-textarea').exists()).toBe(false)
  })

  it('keeps a server-only kind visible so the user can see it before switching', async () => {
    const wrapper = mount(SourceFormSwitch, {
      props: { modelValue: { kind: 'linear', config: {} } },
    })
    await flush()
    const kinds = wrapper.findAll('.sfs-select option').map((o) => o.attributes('value'))
    expect(kinds).toContain('linear')
  })
})
