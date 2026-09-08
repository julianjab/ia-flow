import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import AnthropicApiProviderForm from '@/features/agents/providerForms/AnthropicApiProviderForm.vue'
import JsonProviderForm from '@/features/agents/providerForms/JsonProviderForm.vue'
import TerminalClaudeProviderForm from '@/features/agents/providerForms/TerminalClaudeProviderForm.vue'

// El form lee el catálogo de modelos del store de providers. Se stubea porque
// lo que se está testeando es que MONTE y use el kit, no de dónde saca la lista.
vi.mock('@/features/providers/store', () => ({
  useProvidersStore: () => ({
    config: { anthropicApi: { model: 'claude-opus-5' } },
    models: [],
    fetchConfig: vi.fn(),
  }),
}))

// Los tres migraron del prefijo `.pc-`/`.jpf-` al kit de campo con reemplazos
// de texto, y ninguno tenía quien lo montara. Ver RepoConfigModal.test.ts.

describe('providerForms — montan y usan el kit', () => {
  it('AnthropicApiProviderForm', () => {
    const w = mount(AnthropicApiProviderForm, {
      props: { modelValue: {} },
      global: { stubs: { ComboBox: true, ConcurrencyCapField: true, HintIcon: true } },
    })
    expect(w.findAll('.ff-row').length).toBeGreaterThan(0)
    // Ni un resto del prefijo viejo.
    expect(w.html()).not.toContain('pc-label')
  })

  it('TerminalClaudeProviderForm', () => {
    const w = mount(TerminalClaudeProviderForm, {
      props: { modelValue: {} },
      global: { stubs: { ComboBox: true, ConcurrencyCapField: true, HintIcon: true } },
    })
    expect(w.findAll('.ff-row').length).toBeGreaterThan(0)
    expect(w.html()).not.toContain('pc-label')
  })

  it('JsonProviderForm delega en JsonConfigField y no reimplementa el textarea', () => {
    const w = mount(JsonProviderForm, { props: { modelValue: { foo: 'bar' } } })
    const ta = w.get('textarea.ff-textarea')
    expect((ta.element as HTMLTextAreaElement).value).toContain('"foo"')
    expect(w.html()).not.toContain('jpf-textarea')
  })

  it('un JSON inválido se dice y NO se emite', () => {
    // Emitir basura rompería más adelante, lejos de acá.
    const w = mount(JsonProviderForm, { props: { modelValue: {} } })
    const ta = w.get('textarea.ff-textarea')
    ;(ta.element as HTMLTextAreaElement).value = '{ roto'
    ta.trigger('input')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})
