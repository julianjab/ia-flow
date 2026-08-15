import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PermissionsEditor from '../PermissionsEditor.vue'

const PRESETS = [
  {
    id: 'reviewer',
    description: 'implementer + gh',
    permissions: ['fs.read', 'fs.write', 'bash:gh', 'bash:git.write.task'],
  },
  {
    id: 'releaser',
    description: 'reviewer + push main',
    permissions: ['fs.read', 'fs.write', 'bash:gh', 'bash:git.write.main'],
  },
]

const CATEGORIES = [
  { id: 'fs.read', description: 'lectura', tools: ['fs_read'] },
  { id: 'fs.write', description: 'escritura', tools: ['fs_write'] },
  {
    id: 'bash',
    description: 'exec',
    tools: ['bash_run'],
    bashScopes: [
      { id: 'gh', description: 'gh cli', bins: ['gh'] },
      { id: 'git.write.main', description: 'push main', bins: ['git'] },
    ],
  },
]

function mockFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/api/permission-presets')) {
        return { ok: true, json: async () => PRESETS } as Response
      }
      if (url.endsWith('/api/tools/categories')) {
        return { ok: true, json: async () => CATEGORIES } as Response
      }
      return { ok: false, json: async () => ({}) } as Response
    }),
  )
}

async function flush() {
  // Two rAFs to let onMounted + Promise.all + reactivity settle.
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => mockFetch())
afterEach(() => vi.unstubAllGlobals())

describe('PermissionsEditor', () => {
  it('loads presets and categories on mount', async () => {
    const wrapper = mount(PermissionsEditor, {
      props: { presetId: undefined, permissions: undefined },
    })
    await flush()
    // Preset dropdown has both preset ids plus the "custom" option.
    const options = wrapper.findAll('option')
    const values = options.map((o) => o.attributes('value'))
    expect(values).toContain('reviewer')
    expect(values).toContain('releaser')
    // Category rows render.
    expect(wrapper.text()).toContain('fs.read')
    expect(wrapper.text()).toContain('bash')
    // Bash sub-scopes render under bash.
    expect(wrapper.text()).toContain('bash:gh')
    expect(wrapper.text()).toContain('bash:git.write.main')
  })

  it('emits update:presetId when the dropdown changes', async () => {
    const wrapper = mount(PermissionsEditor, {
      props: { presetId: undefined, permissions: undefined },
    })
    await flush()
    const select = wrapper.find('select')
    await select.setValue('reviewer')
    expect(wrapper.emitted('update:presetId')).toBeTruthy()
    expect(wrapper.emitted('update:presetId')![0]).toEqual(['reviewer'])
  })

  it('marks preset-granted permissions as effective (checked + disabled)', async () => {
    const wrapper = mount(PermissionsEditor, {
      props: { presetId: 'reviewer', permissions: undefined },
    })
    await flush()
    const checkboxes = wrapper.findAll('input[type="checkbox"]')
    // fs.read is in reviewer → checked and disabled (it's implied by preset,
    // toggling would only remove the override — which isn't set — so no-op).
    const fsRead = checkboxes.find((c) => c.attributes('checked') !== undefined)
    expect(fsRead).toBeDefined()
    expect(fsRead!.attributes('disabled')).toBeDefined()
  })

  it('emits update:permissions when the user adds an override', async () => {
    const wrapper = mount(PermissionsEditor, {
      props: { presetId: 'reviewer', permissions: undefined },
    })
    await flush()
    // Find the bash:git.write.main checkbox (not in reviewer preset, so it's
    // togglable — the user is upgrading the reviewer to releaser-ish).
    const rows = wrapper.findAll('.scope-row')
    const target = rows.find((r) => r.text().includes('git.write.main'))
    expect(target).toBeDefined()
    const cb = target!.find('input[type="checkbox"]')
    await cb.setValue(true)
    const emitted = wrapper.emitted('update:permissions')
    expect(emitted).toBeTruthy()
    expect(emitted![0]).toEqual([['bash:git.write.main']])
  })

  it('raw JSON toggle allows editing the array directly', async () => {
    const wrapper = mount(PermissionsEditor, {
      props: { presetId: undefined, permissions: ['fs.read'] },
    })
    await flush()
    await wrapper.find('.btn-raw').trigger('click')
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)
    await textarea.setValue('["fs.read", "task.write"]')
    await wrapper.find('.btn-apply').trigger('click')
    const emitted = wrapper.emitted('update:permissions')
    expect(emitted?.at(-1)).toEqual([['fs.read', 'task.write']])
  })

  it('surfaces a raw-JSON parse error without emitting', async () => {
    const wrapper = mount(PermissionsEditor, {
      props: { presetId: undefined, permissions: undefined },
    })
    await flush()
    await wrapper.find('.btn-raw').trigger('click')
    await wrapper.find('textarea').setValue('not json')
    await wrapper.find('.btn-apply').trigger('click')
    expect(wrapper.find('.raw-err').exists()).toBe(true)
  })
})
